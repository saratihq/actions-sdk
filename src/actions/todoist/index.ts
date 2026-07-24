export {
  PRIORITY_OPTIONS,
  TODOIST_API_BASE,
  type TodoistProject,
  type TodoistTask,
  listProjects,
  projectOptions,
  projectProp,
  todoistAuth,
} from './common';
export {
  CLOSE_TASK_TYPE,
  type CloseTaskResult,
  closeTask,
  CREATE_TASK_TYPE,
  createTask,
  GET_TASKS_TYPE,
  getTasks,
  UPDATE_TASK_TYPE,
  updateTask,
} from './tasks';

export { NEW_TASK_TYPE, newTask } from './new-task.polling';

import { closeTask, createTask, getTasks, updateTask } from './tasks';

/** Every Todoist action, for catalog builds and registration. */
export const todoistActions = [createTask, getTasks, updateTask, closeTask] as const;
