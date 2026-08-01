import { defineAction } from '../../core/action';
import { paginate } from '../../core/http/pagination';
import type { JsonValue } from '../../core/http/types';
import { dropdown, json, longText, shortText } from '../../core/props';
import {
  PRIORITY_OPTIONS,
  TODOIST_API_BASE,
  type TodoistPage,
  type TodoistTask,
  projectProp,
  todoistAuth,
  todoistNextPage,
} from './common';

/** Public types — stable public catalog ids. */
export const CREATE_TASK_TYPE = 'todoist.create_task';
export const GET_TASKS_TYPE = 'todoist.find_task';
export const UPDATE_TASK_TYPE = 'todoist.update_task';
export const CLOSE_TASK_TYPE = 'todoist.mark_task_completed';

/** The static priority picker shared by create/update. */
function priorityProp() {
  return dropdown<number, false>({
    label: 'Priority',
    required: false,
    options: PRIORITY_OPTIONS,
  });
}

/** Create a task; `dueString` is Todoist's natural-language due date and `labels` an array of label names. */
export const createTask = defineAction({
  type: CREATE_TASK_TYPE,
  name: 'Create task',
  description: 'Create a task in Todoist.',
  auth: todoistAuth,
  props: {
    content: shortText<true>({ label: 'Content', description: 'The task text.', required: true }),
    project: projectProp(false, 'Add the task to this project (loaded live); omit for the inbox.'),
    description: longText({ label: 'Description', required: false }),
    priority: priorityProp(),
    dueString: shortText({
      label: 'Due',
      description: 'Natural language, e.g. "tomorrow 4pm".',
      required: false,
    }),
    labels: json({ label: 'Labels', description: 'Array of label names.', required: false }),
  },
  async run({ auth, props, http }): Promise<TodoistTask> {
    const body: Record<string, JsonValue> = { content: props.content };
    if (props.project !== undefined) body.project_id = props.project;
    if (props.description !== undefined) body.description = props.description;
    if (props.priority !== undefined) body.priority = props.priority;
    if (props.dueString !== undefined) body.due_string = props.dueString;
    if (props.labels !== undefined) body.labels = props.labels;
    const res = await http.post<TodoistTask>(`${TODOIST_API_BASE}/tasks`, { auth, body });
    return res.data;
  },
});

/** Get active tasks, optionally scoped to a project and/or a Todoist `filter` query (e.g. `today | overdue`). */
export const getTasks = defineAction({
  type: GET_TASKS_TYPE,
  name: 'Get tasks',
  description: 'Get active Todoist tasks, optionally by project or filter.',
  auth: todoistAuth,
  props: {
    project: projectProp(false, 'Restrict to this project (loaded live).'),
    filter: shortText({
      label: 'Filter',
      description: 'A Todoist filter query, e.g. today.',
      required: false,
    }),
  },
  async run({ auth, props, http }): Promise<{ tasks: TodoistTask[]; count: number }> {
    // A filter MUST use /tasks/filter — plain GET /tasks silently ignores `query`.
    const hasFilter = typeof props.filter === 'string' && props.filter.trim() !== '';
    const { url, query } = hasFilter
      ? { url: `${TODOIST_API_BASE}/tasks/filter`, query: { query: props.filter } }
      : { url: `${TODOIST_API_BASE}/tasks`, query: { project_id: props.project } };
    const tasks = await paginate<TodoistTask>({
      auth,
      http,
      url,
      query,
      extractItems: (res) => (res.data as TodoistPage<TodoistTask>)?.results ?? [],
      nextPage: todoistNextPage,
      maxItems: 500,
    });
    return { tasks, count: tasks.length };
  },
});

/** Update a task. Only the supplied fields change (Todoist update is a POST partial-update). */
export const updateTask = defineAction({
  type: UPDATE_TASK_TYPE,
  name: 'Update task',
  description: 'Update fields of a Todoist task.',
  auth: todoistAuth,
  props: {
    taskId: shortText<true>({ label: 'Task id', required: true }),
    content: shortText({ label: 'Content', required: false }),
    description: longText({ label: 'Description', required: false }),
    priority: priorityProp(),
    dueString: shortText({
      label: 'Due',
      description: 'Natural language, e.g. "tomorrow 4pm".',
      required: false,
    }),
    labels: json({ label: 'Labels', description: 'Array of label names.', required: false }),
  },
  async run({ auth, props, http }): Promise<TodoistTask> {
    const body: Record<string, JsonValue> = {};
    if (props.content !== undefined) body.content = props.content;
    if (props.description !== undefined) body.description = props.description;
    if (props.priority !== undefined) body.priority = props.priority;
    if (props.dueString !== undefined) body.due_string = props.dueString;
    if (props.labels !== undefined) body.labels = props.labels;
    const res = await http.post<TodoistTask>(
      `${TODOIST_API_BASE}/tasks/${encodeURIComponent(props.taskId)}`,
      {
        auth,
        body,
      },
    );
    return res.data;
  },
});

/** The close response — the id of the task that was completed. */
export interface CloseTaskResult {
  closed: boolean;
  taskId: string;
}

/** Mark a task complete. Todoist returns 204 No Content → synthesised confirmation. */
export const closeTask = defineAction({
  type: CLOSE_TASK_TYPE,
  name: 'Close task',
  description: 'Mark a Todoist task as completed.',
  auth: todoistAuth,
  props: {
    taskId: shortText<true>({ label: 'Task id', required: true }),
  },
  async run({ auth, props, http }): Promise<CloseTaskResult> {
    // Re-closing an already-closed task is a Todoist no-op, so the POST may retry.
    await http.post(`${TODOIST_API_BASE}/tasks/${encodeURIComponent(props.taskId)}/close`, {
      auth,
      idempotent: true,
    });
    return { closed: true, taskId: props.taskId };
  },
});
