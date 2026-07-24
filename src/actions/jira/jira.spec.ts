import { HttpClient } from '../../core/http/client';
import type { NormalizedRequest, NormalizedResponse } from '../../core/http/types';
import { FakeTransport, stubAuth } from '../../testing/fakes';
import { addComment, listComments } from './comments';
import { createIssue, getIssue, searchIssues, updateIssue } from './issues';

/**
 * Golden offline tests for the Jira actions. A {@link FakeTransport} replays canned
 * Jira REST v3 responses and records the requests the actions built, so the tests
 * assert both the request shaping (base resolution, ADF, refs, JQL) and the
 * response shaping without a live connection.
 *
 * Base resolution is transport-aware: every action first GETs Atlassian's
 * `accessible-resources`. On the managed/OAuth transport that returns the site(s)
 * the token can reach, and the base becomes the gateway
 * `https://api.atlassian.com/ex/jira/<cloudId>/rest/api/3`; on the direct/basic
 * transport the endpoint 401s and the base falls back to `${instanceUrl}/rest/api/3`.
 * Both transports are exercised below. Live verification: `jira.live.spec.ts`.
 */
const INSTANCE = 'https://orchestrflow.atlassian.net';
const CLOUD_ID = 'b828af84-c9db-4ac5-bc7d-a07b26422193';
const GATEWAY_BASE = `https://api.atlassian.com/ex/jira/${CLOUD_ID}/rest/api/3`;
const ACCESSIBLE_RESOURCES_URL = 'https://api.atlassian.com/oauth/token/accessible-resources';

function fake(handler: (req: NormalizedRequest, callIndex: number) => NormalizedResponse) {
  const transport = new FakeTransport(handler);
  return { auth: stubAuth(transport, 'basic'), http: new HttpClient(), transport };
}

/**
 * Managed/OAuth transport: `accessible-resources` returns one site → the base
 * resolves to the gateway. `onCall` handles the action's real request(s) after
 * resolution.
 */
function managed(onCall: (req: NormalizedRequest, callIndex: number) => NormalizedResponse) {
  return fake((req, callIndex) => {
    if (req.url === ACCESSIBLE_RESOURCES_URL) {
      return {
        status: 200,
        headers: {},
        data: [{ id: CLOUD_ID, url: INSTANCE, name: 'orchestrflow', scopes: ['read:jira-work'] }],
      };
    }
    return onCall(req, callIndex);
  });
}

/**
 * Direct/basic transport: `accessible-resources` needs OAuth and 401s → the base
 * falls back to the site URL. Proves the direct/BYO transport does not regress.
 */
function direct(onCall: (req: NormalizedRequest, callIndex: number) => NormalizedResponse) {
  return fake((req, callIndex) => {
    if (req.url === ACCESSIBLE_RESOURCES_URL) {
      return { status: 401, headers: {}, data: { message: 'OAuth-only endpoint' } };
    }
    return onCall(req, callIndex);
  });
}

/** The one request that is not the base-resolution probe (the action's real call). */
function actionRequests(transport: FakeTransport): NormalizedRequest[] {
  return transport.requests.filter((r) => r.url !== ACCESSIBLE_RESOURCES_URL);
}

describe('jira.create_issue', () => {
  it('routes through the api.atlassian.com gateway on the managed transport, shaping refs + ADF', async () => {
    const { auth, http, transport } = managed(() => ({
      status: 201,
      headers: {},
      data: { id: '10042', key: 'ENG-42', self: `${GATEWAY_BASE}/issue/10042` },
    }));

    const out = await createIssue.execute({
      auth,
      http,
      props: {
        instanceUrl: INSTANCE,
        project: 'ENG',
        issueType: 'Task',
        summary: 'Ship the SDK',
        description: 'Do the thing',
      },
    });

    expect(out).toEqual({ id: '10042', key: 'ENG-42', self: `${GATEWAY_BASE}/issue/10042` });

    // The probe rides first, then the create against the resolved gateway base.
    expect(transport.requests[0]!.url).toBe(ACCESSIBLE_RESOURCES_URL);
    const req = actionRequests(transport)[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe(`${GATEWAY_BASE}/issue`);
    expect(req.url).toContain('api.atlassian.com/ex/jira/');
    const fields = (req.body as { fields: Record<string, unknown> }).fields;
    expect(fields.project).toEqual({ key: 'ENG' });
    expect(fields.issuetype).toEqual({ name: 'Task' });
    expect(fields.summary).toBe('Ship the SDK');
    expect(fields.description).toEqual({
      version: 1,
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Do the thing' }] }],
    });
  });

  it('treats a numeric project as an id and merges additionalFields', async () => {
    const { auth, http, transport } = managed(() => ({
      status: 201,
      headers: {},
      data: { id: '1', key: 'X-1', self: 'x' },
    }));
    await createIssue.execute({
      auth,
      http,
      props: {
        instanceUrl: INSTANCE,
        project: '10001',
        issueType: 'Bug',
        summary: 'x',
        additionalFields: { labels: ['urgent'] },
      },
    });
    const fields = (actionRequests(transport)[0]!.body as { fields: Record<string, unknown> }).fields;
    expect(fields.project).toEqual({ id: '10001' });
    expect(fields.labels).toEqual(['urgent']);
  });

  it('falls back to the site URL on the direct/basic transport (no regression)', async () => {
    const { auth, http, transport } = direct(() => ({
      status: 201,
      headers: {},
      data: { id: '7', key: 'ENG-7', self: 'x' },
    }));
    await createIssue.execute({
      auth,
      http,
      props: { instanceUrl: INSTANCE, project: 'ENG', issueType: 'Task', summary: 'direct rail' },
    });
    expect(actionRequests(transport)[0]!.url).toBe(`${INSTANCE}/rest/api/3/issue`);
  });
});

describe('jira.get_issue', () => {
  it('requests the issue at the gateway base with the expand query and returns it', async () => {
    const { auth, http, transport } = managed(() => ({
      status: 200,
      headers: {},
      data: { id: '10042', key: 'ENG-42', self: 'x', fields: { summary: 'hi' } },
    }));
    const out = await getIssue.execute({
      auth,
      http,
      props: { instanceUrl: INSTANCE, issueIdOrKey: 'ENG-42', expand: 'changelog' },
    });
    expect(out.key).toBe('ENG-42');
    expect(actionRequests(transport)[0]!.url).toBe(`${GATEWAY_BASE}/issue/ENG-42?expand=changelog`);
  });
});

describe('jira.update_issue', () => {
  it('sends only the supplied fields with returnIssue=true against the gateway base', async () => {
    const { auth, http, transport } = managed(() => ({
      status: 200,
      headers: {},
      data: { id: '1', key: 'ENG-1', self: 'x' },
    }));
    await updateIssue.execute({
      auth,
      http,
      props: { instanceUrl: INSTANCE, issueIdOrKey: 'ENG-1', summary: 'new title' },
    });
    const req = actionRequests(transport)[0]!;
    expect(req.method).toBe('PUT');
    expect(req.url).toBe(`${GATEWAY_BASE}/issue/ENG-1?returnIssue=true`);
    expect((req.body as { fields: Record<string, unknown> }).fields).toEqual({ summary: 'new title' });
  });
});

describe('jira.search_issues', () => {
  it('GETs /search/jql with default fields and walks nextPageToken across pages', async () => {
    // Page 1 carries a cursor; page 2 is the last (no nextPageToken) → the walk stops.
    const { auth, http, transport } = managed((req) => {
      if (req.url.includes('nextPageToken=tok2')) {
        return {
          status: 200,
          headers: {},
          data: { issues: [{ id: '2', key: 'ENG-2', self: 'x' }], isLast: true },
        };
      }
      return {
        status: 200,
        headers: {},
        data: { issues: [{ id: '1', key: 'ENG-1', self: 'x' }], nextPageToken: 'tok2' },
      };
    });

    const out = await searchIssues.execute({
      auth,
      http,
      props: { instanceUrl: INSTANCE, jql: 'project = ENG ORDER BY created DESC' },
    });

    expect(out.count).toBe(2);
    expect(out.issues.map((i) => i.key)).toEqual(['ENG-1', 'ENG-2']);

    const calls = actionRequests(transport);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.method).toBe('GET');
    expect(calls[0]!.url).toContain(`${GATEWAY_BASE}/search/jql`);
    // Query params are form-encoded (spaces as `+`); decode both for a readable assert.
    const decoded = decodeURIComponent(calls[0]!.url).replace(/\+/g, ' ');
    // Default fields requested explicitly (the endpoint requires them).
    expect(decoded).toContain('fields=summary,status,assignee,created');
    // The user's JQL is passed through verbatim (bounding it is the caller's job).
    expect(decoded).toContain('jql=project = ENG ORDER BY created DESC');
    // The second page advances via the body cursor on the same query.
    expect(calls[1]!.url).toContain('nextPageToken=tok2');
  });

  it('honours an explicit fields list and caps at maxResults', async () => {
    const { auth, http, transport } = managed(() => ({
      status: 200,
      headers: {},
      // One page bigger than the cap — the result is sliced to maxResults.
      data: {
        issues: [
          { id: '1', key: 'ENG-1', self: 'x' },
          { id: '2', key: 'ENG-2', self: 'x' },
          { id: '3', key: 'ENG-3', self: 'x' },
        ],
        nextPageToken: 'more',
      },
    }));
    const out = await searchIssues.execute({
      auth,
      http,
      props: { instanceUrl: INSTANCE, jql: 'project = ENG', fields: 'summary, key', maxResults: 2 },
    });
    expect(out.count).toBe(2);
    const first = actionRequests(transport)[0]!;
    expect(decodeURIComponent(first.url)).toContain('fields=summary,key');
    expect(first.url).toContain('maxResults=2');
  });
});

describe('jira.add_comment', () => {
  it('wraps plain text as ADF and posts to the gateway base', async () => {
    const { auth, http, transport } = managed(() => ({
      status: 201,
      headers: {},
      data: { id: '9', self: 'x' },
    }));
    await addComment.execute({
      auth,
      http,
      props: { instanceUrl: INSTANCE, issueIdOrKey: 'ENG-1', comment: 'looks good' },
    });
    expect(actionRequests(transport)[0]!.url).toBe(`${GATEWAY_BASE}/issue/ENG-1/comment`);
    expect(actionRequests(transport)[0]!.body).toEqual({
      body: {
        version: 1,
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'looks good' }] }],
      },
    });
  });
});

describe('jira.list_comments', () => {
  it('reads a page from the gateway base and returns comments + total', async () => {
    const { auth, http, transport } = managed(() => ({
      status: 200,
      headers: {},
      data: { comments: [{ id: '9', self: 'x' }], total: 1, startAt: 0, maxResults: 50 },
    }));
    const out = await listComments.execute({
      auth,
      http,
      props: { instanceUrl: INSTANCE, issueIdOrKey: 'ENG-1' },
    });
    expect(out.total).toBe(1);
    expect(out.comments).toHaveLength(1);
    const url = actionRequests(transport)[0]!.url;
    expect(url).toContain(`${GATEWAY_BASE}/issue/ENG-1/comment`);
    expect(url).toContain('orderBy=-created');
    expect(url).toContain('expand=renderedBody');
  });
});
