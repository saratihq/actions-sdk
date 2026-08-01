import { defineAction } from '../../core/action';
import { paginate } from '../../core/http/pagination';
import type { JsonValue } from '../../core/http/types';
import { dropdown, json, longText, number, shortText } from '../../core/props';
import {
  CLICKUP_API_BASE,
  type ClickupTask,
  clickupAuth,
  clickupPageCursor,
  listIdProp,
  PRIORITY_OPTIONS,
} from './common';

/** Public catalog ids for the ClickUp task actions. */
export const CREATE_TASK_TYPE = 'clickup.create_task';
export const GET_TASK_TYPE = 'clickup.get_list_task';
export const UPDATE_TASK_TYPE = 'clickup.update_task';
export const LIST_TASKS_TYPE = 'clickup.list_tasks';

/** The static priority picker shared by create/update. */
function priorityProp() {
  return dropdown<number, false>({
    label: 'Priority',
    required: false,
    options: PRIORITY_OPTIONS,
  });
}

/** Create a task in a list; `assignees` are numeric user ids and `dueDate` is Unix millis. */
export const createTask = defineAction({
  type: CREATE_TASK_TYPE,
  name: 'Create task',
  description: 'Create a task in a ClickUp list.',
  auth: clickupAuth,
  props: {
    listId: listIdProp(),
    name: shortText<true>({ label: 'Name', required: true }),
    description: longText({ label: 'Description', required: false }),
    status: shortText({ label: 'Status', description: 'A status name in the list.', required: false }),
    priority: priorityProp(),
    assignees: json({ label: 'Assignees', description: 'Array of numeric user ids.', required: false }),
    dueDate: number({ label: 'Due date', description: 'Unix time in milliseconds.', required: false }),
  },
  async run({ auth, props, http }): Promise<ClickupTask> {
    const body: Record<string, JsonValue> = { name: props.name };
    if (props.description !== undefined) body.description = props.description;
    if (props.status !== undefined) body.status = props.status;
    if (props.priority !== undefined) body.priority = props.priority;
    if (props.assignees !== undefined) body.assignees = props.assignees;
    if (props.dueDate !== undefined) body.due_date = props.dueDate;
    const res = await http.post<ClickupTask>(
      `${CLICKUP_API_BASE}/list/${encodeURIComponent(props.listId)}/task`,
      { auth, body },
    );
    return res.data;
  },
});

/** Retrieve a task by id. Read-only. */
export const getTask = defineAction({
  type: GET_TASK_TYPE,
  name: 'Get task',
  description: 'Retrieve a ClickUp task by id.',
  auth: clickupAuth,
  props: {
    taskId: shortText<true>({ label: 'Task id', required: true }),
  },
  async run({ auth, props, http }): Promise<ClickupTask> {
    const res = await http.get<ClickupTask>(`${CLICKUP_API_BASE}/task/${encodeURIComponent(props.taskId)}`, {
      auth,
    });
    return res.data;
  },
});

/** Update a task. Only the supplied fields change (ClickUp PUT is a partial update). */
export const updateTask = defineAction({
  type: UPDATE_TASK_TYPE,
  name: 'Update task',
  description: 'Update fields of a ClickUp task.',
  auth: clickupAuth,
  props: {
    taskId: shortText<true>({ label: 'Task id', required: true }),
    name: shortText({ label: 'Name', required: false }),
    description: longText({ label: 'Description', required: false }),
    status: shortText({ label: 'Status', required: false }),
    priority: priorityProp(),
  },
  async run({ auth, props, http }): Promise<ClickupTask> {
    const body: Record<string, JsonValue> = {};
    if (props.name !== undefined) body.name = props.name;
    if (props.description !== undefined) body.description = props.description;
    if (props.status !== undefined) body.status = props.status;
    if (props.priority !== undefined) body.priority = props.priority;
    const res = await http.put<ClickupTask>(`${CLICKUP_API_BASE}/task/${encodeURIComponent(props.taskId)}`, {
      auth,
      body,
    });
    return res.data;
  },
});

/** List the tasks in a list (live picker), following ClickUp's page cursor up to `limit`. */
export const listTasks = defineAction({
  type: LIST_TASKS_TYPE,
  name: 'List tasks',
  description: 'List the tasks in a ClickUp list.',
  auth: clickupAuth,
  props: {
    listId: listIdProp(),
    includeClosed: dropdown<string, false>({
      label: 'Include closed',
      required: false,
      defaultValue: 'false',
      options: [
        { label: 'Open only', value: 'false' },
        { label: 'Include closed', value: 'true' },
      ],
    }),
    limit: number({ label: 'Max results', required: false, defaultValue: 100 }),
  },
  async run({ auth, props, http }): Promise<{ tasks: ClickupTask[]; count: number }> {
    const tasks = await paginate<ClickupTask>({
      http,
      auth,
      url: `${CLICKUP_API_BASE}/list/${encodeURIComponent(props.listId)}/task`,
      query: { page: 0, archived: false, include_closed: props.includeClosed ?? 'false' },
      extractItems: (res) => (res.data as { tasks?: ClickupTask[] }).tasks ?? [],
      nextPage: clickupPageCursor(),
      maxItems: props.limit ?? 100,
    });
    return { tasks, count: tasks.length };
  },
});
