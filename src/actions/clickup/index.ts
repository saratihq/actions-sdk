export {
  CLICKUP_API_BASE,
  type ClickupList,
  type ClickupResource,
  type ClickupTask,
  clickupAuth,
  clickupPageCursor,
  listAllLists,
  listIdProp,
  listOptions,
  listSpaces,
  listTeams,
  PRIORITY_OPTIONS,
  spaceOptions,
} from './common';
export {
  CREATE_TASK_TYPE,
  createTask,
  GET_TASK_TYPE,
  getTask,
  LIST_TASKS_TYPE,
  listTasks,
  UPDATE_TASK_TYPE,
  updateTask,
} from './tasks';

export { NEW_TASK_TYPE, newTask, type ClickupTaskEvent } from './new-task.webhook';

import { createTask, getTask, listTasks, updateTask } from './tasks';

/** Every ClickUp action, for catalog builds and registration. */
export const clickupActions = [createTask, getTask, updateTask, listTasks] as const;
