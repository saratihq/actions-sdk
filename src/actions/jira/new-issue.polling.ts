import { defineTrigger } from '../../core/trigger';
import { shortText } from '../../core/props';
import { instanceUrlProp, jiraAuth, resolveJiraBase } from './common';

/** Polling trigger — fires for each newly created Jira issue (newest-first JQL head, deduped by id). */
export const NEW_ISSUE_TYPE = 'jira.new_issue';

/** Head-of-list window sampled per poll — new issues sort to the top. */
const POLL_WINDOW = 50;

/** The issue fields requested back — trimmed to what workflows use. */
const ISSUE_FIELDS = 'summary,status,issuetype,priority,assignee,created,project';

/** A normalised Jira issue — trimmed to the fields workflows read. */
export interface JiraIssueEvent {
  /** Jira's numeric issue id (stable dedup key). */
  id: string;
  /** The human key, e.g. `ENG-123`. */
  key: string;
  summary: string;
  status?: string;
  issueType?: string;
  priority?: string;
  assignee?: string;
  /** ISO-8601 creation time. */
  created?: string;
  projectKey?: string;
}

/** The Jira search response envelope (the relevant fields). */
interface JiraSearchResponse {
  issues?: Array<{
    id?: string;
    key?: string;
    fields?: {
      summary?: string;
      created?: string;
      status?: { name?: string } | null;
      issuetype?: { name?: string } | null;
      priority?: { name?: string } | null;
      assignee?: { displayName?: string } | null;
      project?: { key?: string } | null;
    };
  }>;
}

/** Escape a JQL string literal (double-quote and backslash). */
function jqlLiteral(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export const newIssue = defineTrigger({
  type: NEW_ISSUE_TYPE,
  strategy: 'polling',
  name: 'New issue',
  description: 'Fires when an issue is created in Jira.',
  auth: jiraAuth,
  props: {
    instanceUrl: instanceUrlProp(),
    projectKey: shortText({
      label: 'Project key',
      description: 'Restrict to one project, e.g. ENG. Leave empty for all projects.',
      required: false,
    }),
  },
  sampleData: {
    id: '10042',
    key: 'ENG-123',
    summary: 'Add user authentication to API endpoints',
    status: 'To Do',
    issueType: 'Task',
    priority: 'High',
    assignee: 'Sarah Chen',
    created: '2025-01-24T14:32:18.076+0000',
    projectKey: 'ENG',
  },
  async poll({ auth, props, http }): Promise<JiraIssueEvent[]> {
    const base = await resolveJiraBase(http, auth, props.instanceUrl);
    const scope = props.projectKey ? `project = "${jqlLiteral(props.projectKey)}" AND ` : '';
    const jql = `${scope}created >= "-1d" ORDER BY created DESC`;
    const res = await http.get<JiraSearchResponse>(`${base}/search/jql`, {
      auth,
      query: { jql, fields: ISSUE_FIELDS, maxResults: POLL_WINDOW },
    });
    const events: JiraIssueEvent[] = [];
    for (const issue of res.data.issues ?? []) {
      if (typeof issue.id !== 'string') continue;
      const f = issue.fields ?? {};
      events.push({
        id: issue.id,
        key: issue.key ?? '',
        summary: f.summary ?? '',
        ...(f.status?.name ? { status: f.status.name } : {}),
        ...(f.issuetype?.name ? { issueType: f.issuetype.name } : {}),
        ...(f.priority?.name ? { priority: f.priority.name } : {}),
        ...(f.assignee?.displayName ? { assignee: f.assignee.displayName } : {}),
        ...(f.created ? { created: f.created } : {}),
        ...(f.project?.key ? { projectKey: f.project.key } : {}),
      });
    }
    return events;
  },
  dedupeKey: (issue) => issue.id,
});
