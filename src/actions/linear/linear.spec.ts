import { ActionError } from '../../core/errors';
import { HttpClient } from '../../core/http/client';
import type { NormalizedRequest, NormalizedResponse } from '../../core/http/types';
import { FakeTransport, stubAuth } from '../../testing/fakes';
import { createComment } from './comments';
import { createIssue, getIssue, listIssues } from './issues';
import { listTeams } from './teams';

/** Offline harness for the Linear GraphQL actions, including the "errors at HTTP 200" path. */
function fake(handler: (req: NormalizedRequest) => NormalizedResponse) {
  const transport = new FakeTransport(handler);
  return { auth: stubAuth(transport, 'apiKey'), http: new HttpClient(), transport };
}

function variables(req: NormalizedRequest): Record<string, unknown> {
  return (req.body as { variables: Record<string, unknown> }).variables;
}

describe('linear.create_issue', () => {
  it('sends the IssueCreateInput and returns the created issue', async () => {
    const issue = { id: 'iss_1', identifier: 'ENG-1', title: 'Ship it', url: 'https://linear.app/x' };
    const { auth, http, transport } = fake(() => ({
      status: 200,
      headers: {},
      data: { data: { issueCreate: { success: true, issue } } },
    }));

    const out = await createIssue.execute({
      auth,
      http,
      props: { teamId: 'team_1', title: 'Ship it', priority: 2, labelIds: 'lbl_a, lbl_b' },
    });

    expect(out).toEqual({ success: true, issue });
    const input = variables(transport.requests[0]!).input as Record<string, unknown>;
    expect(input.teamId).toBe('team_1');
    expect(input.title).toBe('Ship it');
    expect(input.priority).toBe(2);
    expect(input.labelIds).toEqual(['lbl_a', 'lbl_b']);
  });

  it('surfaces a GraphQL error envelope (HTTP 200) as a provider_error', async () => {
    const { auth, http } = fake(() => ({
      status: 200,
      headers: {},
      data: { errors: [{ message: 'Team not found', extensions: { code: 'NOT_FOUND' } }] },
    }));
    await expect(
      createIssue.execute({ auth, http, props: { teamId: 'bad', title: 'x' } }),
    ).rejects.toMatchObject({ code: 'provider_error' });
  });
});

describe('linear.get_issue', () => {
  it('queries by id and returns the issue', async () => {
    const issue = { id: 'iss_1', identifier: 'ENG-1', title: 'Ship it', url: 'u' };
    const { auth, http, transport } = fake(() => ({ status: 200, headers: {}, data: { data: { issue } } }));
    const out = await getIssue.execute({ auth, http, props: { issueId: 'iss_1' } });
    expect(out.identifier).toBe('ENG-1');
    expect(variables(transport.requests[0]!).id).toBe('iss_1');
  });
});

describe('linear.list_issues', () => {
  it('builds a team+assignee filter and returns nodes', async () => {
    const nodes = [{ id: 'iss_1', identifier: 'ENG-1', title: 'a', url: 'u' }];
    const { auth, http, transport } = fake(() => ({
      status: 200,
      headers: {},
      data: { data: { issues: { nodes, pageInfo: { hasNextPage: false } } } },
    }));
    const out = await listIssues.execute({ auth, http, props: { teamId: 'team_1', assigneeId: 'user_1' } });
    expect(out.count).toBe(1);
    const vars = variables(transport.requests[0]!);
    expect(vars.filter).toEqual({ team: { id: { eq: 'team_1' } }, assignee: { id: { eq: 'user_1' } } });
    expect(vars.first).toBe(50);
  });

  it('follows the endCursor across pages up to the limit', async () => {
    let call = 0;
    const { auth, http, transport } = fake(() => {
      const page = call++;
      const node = { id: `iss_${page}`, identifier: `ENG-${page}`, title: 't', url: 'u' };
      return {
        status: 200,
        headers: {},
        data:
          page === 0
            ? { data: { issues: { nodes: [node], pageInfo: { hasNextPage: true, endCursor: 'cur1' } } } }
            : { data: { issues: { nodes: [node], pageInfo: { hasNextPage: false, endCursor: null } } } },
      };
    });
    const out = await listIssues.execute({ auth, http, props: { limit: 100 } });
    expect(out.count).toBe(2);
    // The second request carries the first page's endCursor as `after`.
    expect(variables(transport.requests[1]!).after).toBe('cur1');
  });
});

describe('linear.create_comment', () => {
  it('posts the CommentCreateInput', async () => {
    const comment = { id: 'c_1', body: 'nice', url: 'u' };
    const { auth, http, transport } = fake(() => ({
      status: 200,
      headers: {},
      data: { data: { commentCreate: { success: true, comment } } },
    }));
    const out = await createComment.execute({ auth, http, props: { issueId: 'iss_1', body: 'nice' } });
    expect(out).toEqual({ success: true, comment });
    expect(variables(transport.requests[0]!).input).toEqual({ issueId: 'iss_1', body: 'nice' });
  });
});

describe('linear.list_teams + team picker', () => {
  it('lists teams and the picker maps name (key)', async () => {
    const nodes = [{ id: 'team_1', name: 'Engineering', key: 'ENG' }];
    const { auth, http } = fake(() => ({
      status: 200,
      headers: {},
      data: { data: { teams: { nodes, pageInfo: { hasNextPage: false } } } },
    }));
    const out = await listTeams.execute({ auth, http, props: {} });
    expect(out.count).toBe(1);

    const picker = await createIssue.loadOptions('teamId', { auth, http });
    expect(picker.disabled).toBe(false);
    expect(picker.options[0]).toEqual({ label: 'Engineering (ENG)', value: 'team_1' });
  });

  it('the picker is inert without a connection', async () => {
    const result = await createIssue.loadOptions('teamId', {});
    expect(result.disabled).toBe(true);
    expect(result.options).toEqual([]);
  });
});

describe('ActionError contract', () => {
  it('is the one thrown shape', async () => {
    const { auth, http } = fake(() => ({
      status: 200,
      headers: {},
      data: { errors: [{ message: 'boom' }] },
    }));
    await expect(getIssue.execute({ auth, http, props: { issueId: 'x' } })).rejects.toBeInstanceOf(
      ActionError,
    );
  });
});
