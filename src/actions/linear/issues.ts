import { defineAction } from '../../core/action';
import { dropdown, longText, number, shortText } from '../../core/props';
import { linearAuth, linearGraphql, PRIORITY_OPTIONS, teamOptions, userOptions } from './common';

/** Public types — stable public catalog ids. */
export const CREATE_ISSUE_TYPE = 'linear.create_issue';
export const UPDATE_ISSUE_TYPE = 'linear.update_issue';
export const GET_ISSUE_TYPE = 'linear.get_issue';
export const LIST_ISSUES_TYPE = 'linear.list_issues';

/** A Linear issue, trimmed to the fields workflows read. */
export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  url: string;
  description?: string | null;
  priority?: number;
  state?: { id: string; name: string } | null;
  assignee?: { id: string; name: string } | null;
  team?: { id: string; name: string; key: string } | null;
  createdAt?: string;
  updatedAt?: string;
}

const ISSUE_FIELDS = `id identifier title url description priority
  state { id name } assignee { id name } team { id name key } createdAt updatedAt`;

const CREATE_MUTATION = `mutation IssueCreate($input: IssueCreateInput!) {
  issueCreate(input: $input) { success issue { ${ISSUE_FIELDS} } }
}`;

const UPDATE_MUTATION = `mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) { success issue { ${ISSUE_FIELDS} } }
}`;

const GET_QUERY = `query Issue($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} } }`;

const LIST_QUERY = `query Issues($filter: IssueFilter, $first: Int, $after: String) {
  issues(filter: $filter, first: $first, after: $after) {
    nodes { ${ISSUE_FIELDS} }
    pageInfo { hasNextPage endCursor }
  }
}`;

/** One page of a Linear issue connection — nodes plus the cursor to advance. */
interface IssueConnection {
  nodes: LinearIssue[];
  pageInfo: { hasNextPage: boolean; endCursor?: string | null };
}

function splitIds(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const ids = value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return ids.length > 0 ? ids : undefined;
}

/** Create an issue in a team; state/label/project stay id inputs because they are team-scoped. */
export const createIssue = defineAction({
  type: CREATE_ISSUE_TYPE,
  name: 'Create issue',
  description: 'Create a new issue in a Linear team.',
  auth: linearAuth,
  props: {
    teamId: dropdown<string, true>({
      label: 'Team',
      description: 'The team the issue belongs to — loaded live from your workspace.',
      required: true,
      options: ({ auth, http }) => teamOptions(http, auth),
    }),
    title: shortText<true>({ label: 'Title', required: true }),
    description: longText({ label: 'Description', description: 'Markdown supported.', required: false }),
    assigneeId: dropdown<string, false>({
      label: 'Assignee',
      required: false,
      options: ({ auth, http }) => userOptions(http, auth),
    }),
    stateId: shortText({
      label: 'State id',
      description: 'Workflow-state id (team-specific).',
      required: false,
    }),
    priority: dropdown<number, false>({ label: 'Priority', required: false, options: PRIORITY_OPTIONS }),
    labelIds: shortText({ label: 'Label ids', description: 'Comma-separated label ids.', required: false }),
    projectId: shortText({ label: 'Project id', required: false }),
  },
  async run({ auth, props, http }): Promise<{ success: boolean; issue: LinearIssue }> {
    const input: Record<string, unknown> = { teamId: props.teamId, title: props.title };
    if (props.description !== undefined) input.description = props.description;
    if (props.assigneeId !== undefined) input.assigneeId = props.assigneeId;
    if (props.stateId !== undefined) input.stateId = props.stateId;
    if (props.priority !== undefined) input.priority = props.priority;
    if (props.projectId !== undefined) input.projectId = props.projectId;
    const labelIds = splitIds(props.labelIds);
    if (labelIds) input.labelIds = labelIds;
    return linearGraphql<{ issueCreate: { success: boolean; issue: LinearIssue } }>(
      http,
      auth,
      CREATE_MUTATION,
      {
        input,
      },
    ).then((d) => ({ success: d.issueCreate.success, issue: d.issueCreate.issue }));
  },
});

/** Update fields on an existing issue. Every field is optional; only supplied ones change. */
export const updateIssue = defineAction({
  type: UPDATE_ISSUE_TYPE,
  name: 'Update issue',
  description: 'Update an existing Linear issue.',
  auth: linearAuth,
  props: {
    issueId: shortText<true>({ label: 'Issue id', required: true }),
    title: shortText({ label: 'Title', required: false }),
    description: longText({ label: 'Description', required: false }),
    assigneeId: dropdown<string, false>({
      label: 'Assignee',
      required: false,
      options: ({ auth, http }) => userOptions(http, auth),
    }),
    stateId: shortText({ label: 'State id', required: false }),
    priority: dropdown<number, false>({ label: 'Priority', required: false, options: PRIORITY_OPTIONS }),
  },
  async run({ auth, props, http }): Promise<{ success: boolean; issue: LinearIssue }> {
    const input: Record<string, unknown> = {};
    if (props.title !== undefined) input.title = props.title;
    if (props.description !== undefined) input.description = props.description;
    if (props.assigneeId !== undefined) input.assigneeId = props.assigneeId;
    if (props.stateId !== undefined) input.stateId = props.stateId;
    if (props.priority !== undefined) input.priority = props.priority;
    return linearGraphql<{ issueUpdate: { success: boolean; issue: LinearIssue } }>(
      http,
      auth,
      UPDATE_MUTATION,
      {
        id: props.issueId,
        input,
      },
    ).then((d) => ({ success: d.issueUpdate.success, issue: d.issueUpdate.issue }));
  },
});

/** Fetch a single issue by id. Read-only. */
export const getIssue = defineAction({
  type: GET_ISSUE_TYPE,
  name: 'Get issue',
  description: 'Get a Linear issue by id.',
  auth: linearAuth,
  props: {
    issueId: shortText<true>({ label: 'Issue id', required: true }),
  },
  async run({ auth, props, http }): Promise<LinearIssue> {
    const data = await linearGraphql<{ issue: LinearIssue }>(http, auth, GET_QUERY, { id: props.issueId });
    return data.issue;
  },
});

/** List issues, optionally scoped to a team or assignee, following `pageInfo.endCursor` up to `limit`. */
export const listIssues = defineAction({
  type: LIST_ISSUES_TYPE,
  name: 'List issues',
  description: 'List Linear issues, optionally filtered by team or assignee.',
  auth: linearAuth,
  props: {
    teamId: dropdown<string, false>({
      label: 'Team',
      required: false,
      options: ({ auth, http }) => teamOptions(http, auth),
    }),
    assigneeId: dropdown<string, false>({
      label: 'Assignee',
      required: false,
      options: ({ auth, http }) => userOptions(http, auth),
    }),
    limit: number({ label: 'Max results', required: false, defaultValue: 50 }),
  },
  async run({ auth, props, http }): Promise<{ issues: LinearIssue[]; count: number }> {
    const filter: Record<string, unknown> = {};
    if (props.teamId !== undefined) filter.team = { id: { eq: props.teamId } };
    if (props.assigneeId !== undefined) filter.assignee = { id: { eq: props.assigneeId } };
    const hasFilter = Object.keys(filter).length > 0;
    const max = props.limit ?? 50;
    const issues: LinearIssue[] = [];
    let cursor: string | null = null;
    // Cap the page walk so a runaway cursor can't loop forever (mirrors paginate()).
    for (let page = 0; page < 20 && issues.length < max; page += 1) {
      const variables: Record<string, unknown> = {
        first: Math.min(100, max - issues.length),
        after: cursor,
        ...(hasFilter ? { filter } : {}),
      };
      const conn = (await linearGraphql<{ issues: IssueConnection }>(http, auth, LIST_QUERY, variables))
        .issues;
      issues.push(...conn.nodes);
      if (!conn.pageInfo.hasNextPage || !conn.pageInfo.endCursor) break;
      cursor = conn.pageInfo.endCursor;
    }
    const capped = issues.slice(0, max);
    return { issues: capped, count: capped.length };
  },
});
