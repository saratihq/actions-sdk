export { type AtlassianResource, jiraAuth, resolveJiraBase, textToAdf } from './common';
export {
  CREATE_ISSUE_TYPE,
  createIssue,
  GET_ISSUE_TYPE,
  getIssue,
  type JiraIssue,
  type JiraIssueRef,
  type JiraSearchPage,
  type JiraSearchResult,
  SEARCH_ISSUES_TYPE,
  searchIssues,
  UPDATE_ISSUE_TYPE,
  updateIssue,
} from './issues';
export { ADD_COMMENT_TYPE, addComment, type JiraComment, LIST_COMMENTS_TYPE, listComments } from './comments';
export { NEW_ISSUE_TYPE, newIssue, type JiraIssueEvent } from './new-issue.polling';

import { addComment, listComments } from './comments';
import { createIssue, getIssue, searchIssues, updateIssue } from './issues';

/** Every Jira action, for catalog builds and registration. */
export const jiraActions = [
  createIssue,
  getIssue,
  updateIssue,
  searchIssues,
  addComment,
  listComments,
] as const;
