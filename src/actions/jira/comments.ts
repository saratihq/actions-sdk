import { defineAction } from '../../core/action';
import type { JsonValue } from '../../core/http/types';
import { checkbox, dropdown, number, shortText } from '../../core/props';
import { instanceUrlProp, jiraAuth, resolveJiraBase, textToAdf } from './common';

/** Public types — stable public catalog ids. */
export const ADD_COMMENT_TYPE = 'jira.add_comment';
export const LIST_COMMENTS_TYPE = 'jira.list_comments';

/** A Jira comment, trimmed to the fields workflows read. */
export interface JiraComment {
  id: string;
  self: string;
  body?: JsonValue;
  renderedBody?: string;
  author?: { accountId?: string; displayName?: string };
  created?: string;
  updated?: string;
}

interface JiraCommentPage {
  comments: JiraComment[];
  total: number;
  startAt: number;
  maxResults: number;
}

/**
 * Add a comment to an issue. Plain text is shaped into ADF for you; set
 * `isAdf` to pass a raw ADF document as JSON instead (advanced).
 */
export const addComment = defineAction({
  type: ADD_COMMENT_TYPE,
  name: 'Add comment',
  description: 'Add a comment to a Jira issue.',
  auth: jiraAuth,
  props: {
    instanceUrl: instanceUrlProp(),
    issueIdOrKey: shortText<true>({ label: 'Issue id or key', required: true }),
    comment: shortText<true>({ label: 'Comment', required: true }),
    isAdf: checkbox({
      label: 'Comment is ADF JSON',
      description: 'Treat the comment as a raw Atlassian Document Format document.',
      required: false,
      defaultValue: false,
    }),
  },
  async run({ auth, props, http }): Promise<JiraComment> {
    const base = await resolveJiraBase(http, auth, props.instanceUrl);
    let body: JsonValue;
    if (props.isAdf) {
      body = JSON.parse(props.comment) as JsonValue;
    } else {
      body = textToAdf(props.comment);
    }
    const res = await http.post<JiraComment>(
      `${base}/issue/${encodeURIComponent(props.issueIdOrKey)}/comment`,
      { auth, body: { body } },
    );
    return res.data;
  },
});

/** List an issue's comments, newest or oldest first, with rendered HTML bodies. Read-only. */
export const listComments = defineAction({
  type: LIST_COMMENTS_TYPE,
  name: 'List comments',
  description: 'List the comments on a Jira issue.',
  auth: jiraAuth,
  props: {
    instanceUrl: instanceUrlProp(),
    issueIdOrKey: shortText<true>({ label: 'Issue id or key', required: true }),
    orderBy: dropdown<string, false>({
      label: 'Order by',
      required: false,
      defaultValue: '-created',
      options: [
        { label: 'Created (newest first)', value: '-created' },
        { label: 'Created (oldest first)', value: '+created' },
      ],
    }),
    maxResults: number({ label: 'Max results', required: false, defaultValue: 50 }),
  },
  async run({ auth, props, http }): Promise<{ comments: JiraComment[]; total: number }> {
    const base = await resolveJiraBase(http, auth, props.instanceUrl);
    const res = await http.get<JiraCommentPage>(
      `${base}/issue/${encodeURIComponent(props.issueIdOrKey)}/comment`,
      {
        auth,
        query: {
          orderBy: props.orderBy ?? '-created',
          maxResults: props.maxResults ?? 50,
          expand: 'renderedBody',
        },
      },
    );
    return { comments: res.data.comments, total: res.data.total };
  },
});
