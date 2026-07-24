import { defineAction } from '../../core/action';
import { cursorInBody, paginate } from '../../core/http/pagination';
import type { JsonValue } from '../../core/http/types';
import { dropdown, json, longText, number, shortText } from '../../core/props';
import { instanceUrlProp, jiraAuth, namedRef, projectRef, resolveJiraBase, textToAdf } from './common';

/** Public types — stable public catalog ids. */
export const CREATE_ISSUE_TYPE = 'jira.create_issue';
export const GET_ISSUE_TYPE = 'jira.get_issue';
export const UPDATE_ISSUE_TYPE = 'jira.update_issue';
export const SEARCH_ISSUES_TYPE = 'jira.search_issues';

/** A Jira issue, trimmed to the fields workflows read. `fields` stays open — schemas vary per project. */
export interface JiraIssue {
  id: string;
  key: string;
  self: string;
  fields?: Record<string, JsonValue>;
}

/** The `POST /issue` response (Jira returns only identifiers on create). */
export interface JiraIssueRef {
  id: string;
  key: string;
  self: string;
}

/** One page of the token-paginated `GET /search/jql` — `nextPageToken` is absent on the last page. */
export interface JiraSearchPage {
  issues: JiraIssue[];
  nextPageToken?: string;
  isLast?: boolean;
}

/** The `search_issues` result: the collected issues plus their count. */
export interface JiraSearchResult {
  issues: JiraIssue[];
  count: number;
}

/**
 * Default fields to request from `/search/jql`. The endpoint requires an explicit
 * `fields` param (unlike the retired `/search`, which defaulted to all navigable
 * fields), so the SDK asks for a workflow-useful core; callers override via the
 * `fields` prop.
 */
const DEFAULT_SEARCH_FIELDS = ['summary', 'status', 'assignee', 'created'];

/**
 * Advance `/search/jql`: the next-page cursor lives at `nextPageToken` in the body
 * and rides back as `?nextPageToken=` on the same URL (absent → last page → stop).
 */
const searchNextPage = cursorInBody({ cursorPath: ['nextPageToken'], cursorParam: 'nextPageToken' });

/** Assemble the `fields` object shared by create and update from the common typed props. */
function buildFields(input: {
  summary?: string;
  issueType?: string;
  description?: string;
  assigneeId?: string;
  priority?: string;
  parentKey?: string;
  additionalFields?: JsonValue;
}): Record<string, JsonValue> {
  const fields: Record<string, JsonValue> = {};
  if (input.summary !== undefined) fields.summary = input.summary;
  if (input.issueType !== undefined) fields.issuetype = namedRef(input.issueType);
  if (input.description !== undefined) fields.description = textToAdf(input.description);
  if (input.assigneeId !== undefined) fields.assignee = { id: input.assigneeId };
  if (input.priority !== undefined) fields.priority = namedRef(input.priority);
  if (input.parentKey !== undefined) fields.parent = { key: input.parentKey };
  if (
    input.additionalFields &&
    typeof input.additionalFields === 'object' &&
    !Array.isArray(input.additionalFields)
  ) {
    Object.assign(fields, input.additionalFields);
  }
  return fields;
}

/**
 * Create an issue in a project. The core write verb. `project` and `issueType`
 * accept either an id or the human key/name; rich-text `description` is supplied
 * as plain text and shaped into ADF for you. `additionalFields` is the escape
 * hatch for labels/custom fields (raw Jira `fields` JSON).
 */
export const createIssue = defineAction({
  type: CREATE_ISSUE_TYPE,
  name: 'Create issue',
  description: 'Create a new issue in a Jira project.',
  auth: jiraAuth,
  props: {
    instanceUrl: instanceUrlProp(),
    project: shortText<true>({
      label: 'Project',
      description: 'Project key (e.g. ENG) or numeric id.',
      required: true,
    }),
    issueType: shortText<true>({
      label: 'Issue type',
      description: 'Issue type name (e.g. Task, Bug) or id.',
      required: true,
    }),
    summary: shortText<true>({ label: 'Summary', required: true }),
    description: longText({ label: 'Description', required: false }),
    assigneeId: shortText({ label: 'Assignee account id', required: false }),
    priority: shortText({
      label: 'Priority',
      description: 'Priority name (e.g. High) or id.',
      required: false,
    }),
    parentKey: shortText({
      label: 'Parent key',
      description: 'Parent issue key for a sub-task.',
      required: false,
    }),
    additionalFields: json({
      label: 'Additional fields',
      description: 'Raw Jira `fields` JSON to merge in.',
      required: false,
    }),
  },
  async run({ auth, props, http }): Promise<JiraIssueRef> {
    const base = await resolveJiraBase(http, auth, props.instanceUrl);
    const fields: Record<string, JsonValue> = {
      project: projectRef(props.project),
      ...buildFields({
        summary: props.summary,
        issueType: props.issueType,
        ...(props.description !== undefined ? { description: props.description } : {}),
        ...(props.assigneeId !== undefined ? { assigneeId: props.assigneeId } : {}),
        ...(props.priority !== undefined ? { priority: props.priority } : {}),
        ...(props.parentKey !== undefined ? { parentKey: props.parentKey } : {}),
        ...(props.additionalFields !== undefined ? { additionalFields: props.additionalFields } : {}),
      }),
    };
    const res = await http.post<JiraIssueRef>(`${base}/issue`, {
      auth,
      body: { fields },
    });
    return res.data;
  },
});

/** Fetch a single issue by id or key. Read-only. */
export const getIssue = defineAction({
  type: GET_ISSUE_TYPE,
  name: 'Get issue',
  description: 'Get a Jira issue by id or key.',
  auth: jiraAuth,
  props: {
    instanceUrl: instanceUrlProp(),
    issueIdOrKey: shortText<true>({ label: 'Issue id or key', description: 'e.g. ENG-42.', required: true }),
    expand: dropdown<string, false>({
      label: 'Expand',
      description: 'Optional extra data to include.',
      required: false,
      options: [
        { label: 'Rendered fields', value: 'renderedFields' },
        { label: 'Names', value: 'names' },
        { label: 'Transitions', value: 'transitions' },
        { label: 'Changelog', value: 'changelog' },
      ],
    }),
  },
  async run({ auth, props, http }): Promise<JiraIssue> {
    const base = await resolveJiraBase(http, auth, props.instanceUrl);
    const res = await http.get<JiraIssue>(`${base}/issue/${encodeURIComponent(props.issueIdOrKey)}`, {
      auth,
      query: { expand: props.expand },
    });
    return res.data;
  },
});

/**
 * Update fields on an existing issue. Every field is optional; only the ones you
 * supply are changed. `returnIssue=true` echoes the updated issue back.
 */
export const updateIssue = defineAction({
  type: UPDATE_ISSUE_TYPE,
  name: 'Update issue',
  description: 'Update fields on an existing Jira issue.',
  auth: jiraAuth,
  props: {
    instanceUrl: instanceUrlProp(),
    issueIdOrKey: shortText<true>({ label: 'Issue id or key', required: true }),
    summary: shortText({ label: 'Summary', required: false }),
    issueType: shortText({ label: 'Issue type', description: 'Issue type name or id.', required: false }),
    description: longText({ label: 'Description', required: false }),
    assigneeId: shortText({ label: 'Assignee account id', required: false }),
    priority: shortText({ label: 'Priority', required: false }),
    additionalFields: json({
      label: 'Additional fields',
      description: 'Raw Jira `fields` JSON to merge in.',
      required: false,
    }),
  },
  async run({ auth, props, http }): Promise<JiraIssue> {
    const base = await resolveJiraBase(http, auth, props.instanceUrl);
    const fields = buildFields({
      ...(props.summary !== undefined ? { summary: props.summary } : {}),
      ...(props.issueType !== undefined ? { issueType: props.issueType } : {}),
      ...(props.description !== undefined ? { description: props.description } : {}),
      ...(props.assigneeId !== undefined ? { assigneeId: props.assigneeId } : {}),
      ...(props.priority !== undefined ? { priority: props.priority } : {}),
      ...(props.additionalFields !== undefined ? { additionalFields: props.additionalFields } : {}),
    });
    const res = await http.put<JiraIssue>(`${base}/issue/${encodeURIComponent(props.issueIdOrKey)}`, {
      auth,
      query: { returnIssue: true },
      body: { fields },
    });
    return res.data;
  },
});

/**
 * Search issues with JQL via `GET /search/jql` (the retired `/search` now 410s).
 * `/search/jql` uses token pagination — the response carries `{ issues,
 * nextPageToken? }` — so the SDK walks `nextPageToken` to completion, capped at
 * `maxResults` issues. The `jql` is passed through verbatim: `/search/jql` rejects
 * an UNBOUNDED query with 400, so bounding it is the caller's responsibility.
 */
export const searchIssues = defineAction({
  type: SEARCH_ISSUES_TYPE,
  name: 'Search issues',
  description: 'Search Jira issues with a JQL query.',
  auth: jiraAuth,
  props: {
    instanceUrl: instanceUrlProp(),
    jql: longText<true>({
      label: 'JQL',
      description: 'e.g. project = ENG AND status = "In Progress" ORDER BY created DESC',
      required: true,
    }),
    maxResults: number({
      label: 'Max results',
      description: 'Cap on issues returned across pages.',
      required: false,
      defaultValue: 50,
    }),
    fields: shortText({
      label: 'Fields',
      description: `Comma-separated field ids to return (default: ${DEFAULT_SEARCH_FIELDS.join(', ')}).`,
      required: false,
    }),
  },
  async run({ auth, props, http }): Promise<JiraSearchResult> {
    const base = await resolveJiraBase(http, auth, props.instanceUrl);
    const cap = props.maxResults ?? 50;
    const fieldList = props.fields
      ?.split(',')
      .map((f) => f.trim())
      .filter((f) => f.length > 0);
    const issues = await paginate<JiraIssue>({
      http,
      auth,
      url: `${base}/search/jql`,
      query: {
        jql: props.jql,
        maxResults: cap,
        fields: (fieldList && fieldList.length > 0 ? fieldList : DEFAULT_SEARCH_FIELDS).join(','),
      },
      extractItems: (res) => (res.data as JiraSearchPage)?.issues ?? [],
      nextPage: searchNextPage,
      maxItems: cap,
    });
    return { issues, count: issues.length };
  },
});
