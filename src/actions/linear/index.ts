export {
  type GraphqlResponse,
  LINEAR_GRAPHQL_URL,
  type LinearTeam,
  type LinearUser,
  linearAuth,
  linearGraphql,
  listLinearTeams,
  listLinearUsers,
} from './common';
export {
  CREATE_ISSUE_TYPE,
  createIssue,
  GET_ISSUE_TYPE,
  getIssue,
  type LinearIssue,
  LIST_ISSUES_TYPE,
  listIssues,
  UPDATE_ISSUE_TYPE,
  updateIssue,
} from './issues';
export { CREATE_COMMENT_TYPE, createComment, type LinearComment } from './comments';
export { LIST_TEAMS_TYPE, listTeams } from './teams';
export { NEW_ISSUE_TYPE, newIssue, type LinearIssueEvent } from './new-issue.webhook';

import { createComment } from './comments';
import { createIssue, getIssue, listIssues, updateIssue } from './issues';
import { listTeams } from './teams';

/** Every Linear action, for catalog builds and registration. */
export const linearActions = [
  createIssue,
  updateIssue,
  getIssue,
  listIssues,
  createComment,
  listTeams,
] as const;
