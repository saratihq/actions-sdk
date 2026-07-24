export {
  ASANA_API_BASE,
  type AsanaResource,
  type AsanaStory,
  type AsanaTask,
  asanaAuth,
  asanaGet,
  listAsanaProjects,
  listAsanaWorkspaces,
  projectOptions,
  projectProp,
  workspaceOptions,
  workspaceProp,
} from './common';
export {
  ADD_COMMENT_TYPE,
  addComment,
  CREATE_TASK_TYPE,
  createTask,
  GET_TASK_TYPE,
  getTask,
  LIST_TASKS_TYPE,
  listTasks,
  UPDATE_TASK_TYPE,
  updateTask,
} from './tasks';
export { LIST_PROJECTS_TYPE, listProjects } from './projects';
export { NEW_TASK_TYPE, newTask } from './new-task.polling';

import { listProjects } from './projects';
import { addComment, createTask, getTask, listTasks, updateTask } from './tasks';

/** Every Asana action, for catalog builds and registration. */
export const asanaActions = [createTask, getTask, updateTask, listTasks, listProjects, addComment] as const;
