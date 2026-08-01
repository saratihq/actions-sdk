import type { NormalizedRequest, NormalizedResponse } from '../../core/http/types';
import { FakeTransport, stubAuth } from '../../testing/fakes';
import { MemoryStore } from '../../testing/memory-store';
import { type JiraIssueEvent, newIssue } from './new-issue.polling';

const INSTANCE = 'https://acme.atlassian.net';

/** One issue as Jira's `/search/jql` returns it (shape from the REST v3 docs). */
function issue(id: string, key: string, summary: string) {
  return {
    id,
    key,
    fields: {
      summary,
      created: '2025-01-24T14:32:18.076+0000',
      status: { name: 'To Do' },
      issuetype: { name: 'Task' },
      priority: { name: 'High' },
      assignee: { displayName: 'Sarah Chen' },
      project: { key: 'ENG' },
    },
  };
}

/** A BYO/basic transport: `accessible-resources` 401s (→ fall back to the instance URL); `/search/jql` answers. */
function jiraTransport(issues: unknown[]): FakeTransport {
  return new FakeTransport((req: NormalizedRequest): NormalizedResponse => {
    if (req.url.includes('accessible-resources'))
      return { status: 401, headers: {}, data: { message: 'no' } };
    if (req.url.includes('/search/jql')) return { status: 200, headers: {}, data: { issues } };
    return { status: 404, headers: {}, data: null };
  });
}

describe('jira.new_issue polling trigger', () => {
  it('roots the search at the instance URL and normalises a real issue', async () => {
    const transport = jiraTransport([issue('10042', 'ENG-123', 'Add user authentication')]);
    const result = await newIssue.runPoll({
      auth: stubAuth(transport, 'basic'),
      props: { instanceUrl: INSTANCE, projectKey: 'ENG' },
      store: new MemoryStore(),
    });

    expect(result.events).toEqual<JiraIssueEvent[]>([
      {
        id: '10042',
        key: 'ENG-123',
        summary: 'Add user authentication',
        status: 'To Do',
        issueType: 'Task',
        priority: 'High',
        assignee: 'Sarah Chen',
        created: '2025-01-24T14:32:18.076+0000',
        projectKey: 'ENG',
      },
    ]);

    const search = transport.requests.find((r) => r.url.includes('/search/jql'))!;
    expect(search.url).toContain('https://acme.atlassian.net/rest/api/3/search/jql');
    // The project scope + newest-first ordering ride the JQL.
    const jql = decodeURIComponent(new URL(search.url).searchParams.get('jql') ?? '');
    expect(jql).toContain('project = "ENG"');
    expect(jql).toContain('ORDER BY created DESC');
  });

  it('emits new issues, then dedupes by id on the next poll', async () => {
    const store = new MemoryStore();
    const first = await newIssue.runPoll({
      auth: stubAuth(jiraTransport([issue('2', 'ENG-2', 'two'), issue('1', 'ENG-1', 'one')]), 'basic'),
      props: { instanceUrl: INSTANCE },
      store,
    });
    expect(first.events.map((e) => e.id)).toEqual(['2', '1']);

    const second = await newIssue.runPoll({
      auth: stubAuth(jiraTransport([issue('2', 'ENG-2', 'two'), issue('1', 'ENG-1', 'one')]), 'basic'),
      props: { instanceUrl: INSTANCE },
      store,
    });
    expect(second.events).toEqual([]);

    const third = await newIssue.runPoll({
      auth: stubAuth(jiraTransport([issue('3', 'ENG-3', 'three'), issue('2', 'ENG-2', 'two')]), 'basic'),
      props: { instanceUrl: INSTANCE },
      store,
    });
    expect(third.events.map((e) => e.id)).toEqual(['3']);
  });
});
