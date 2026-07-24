import { defineAction } from '../../core/action';
import { cursorInBody, paginate } from '../../core/http/pagination';
import type { JsonValue } from '../../core/http/types';
import { checkbox, longText, number, shortText } from '../../core/props';
import {
  ASANA_API_BASE,
  asanaGet,
  type AsanaStory,
  type AsanaTask,
  asanaAuth,
  projectProp,
  workspaceProp,
} from './common';

/** Public types — stable public catalog ids. */
export const CREATE_TASK_TYPE = 'asana.create_task';
export const GET_TASK_TYPE = 'asana.get_task';
export const UPDATE_TASK_TYPE = 'asana.update_task';
export const LIST_TASKS_TYPE = 'asana.list_tasks';
export const ADD_COMMENT_TYPE = 'asana.add_comment';

/** The task fields requested back on reads/writes. */
const TASK_FIELDS = 'name,notes,completed,due_on,due_at,assignee.name,permalink_url,projects.name';

/**
 * Create a task. A task must live in either a `project` (picker) or a `workspace`
 * (picker) — supply at least one; when only a workspace is given the task lands in
 * that workspace's "My Tasks". `assignee` is a user gid or the literal `me`.
 */
export const createTask = defineAction({
  type: CREATE_TASK_TYPE,
  name: 'Create task',
  description: 'Create a task in Asana.',
  auth: asanaAuth,
  props: {
    name: shortText<true>({ label: 'Name', required: true }),
    project: projectProp(false, 'Add the task to this project (loaded live).'),
    workspace: workspaceProp(false),
    notes: longText({ label: 'Notes', required: false }),
    assignee: shortText({ label: 'Assignee', description: 'User gid, or "me".', required: false }),
    dueOn: shortText({ label: 'Due date', description: 'YYYY-MM-DD.', required: false }),
  },
  async run({ auth, props, http }): Promise<AsanaTask> {
    const data: Record<string, JsonValue> = { name: props.name };
    if (props.project !== undefined) data.projects = [props.project];
    if (props.workspace !== undefined) data.workspace = props.workspace;
    if (props.notes !== undefined) data.notes = props.notes;
    if (props.assignee !== undefined) data.assignee = props.assignee;
    if (props.dueOn !== undefined) data.due_on = props.dueOn;
    const res = await http.post<{ data: AsanaTask }>(`${ASANA_API_BASE}/tasks`, {
      auth,
      query: { opt_fields: TASK_FIELDS },
      body: { data },
    });
    return res.data.data;
  },
});

/** Retrieve a task by gid. Read-only. */
export const getTask = defineAction({
  type: GET_TASK_TYPE,
  name: 'Get task',
  description: 'Retrieve an Asana task by id.',
  auth: asanaAuth,
  props: {
    taskId: shortText<true>({ label: 'Task id', required: true }),
  },
  async run({ auth, props, http }): Promise<AsanaTask> {
    const url = `${ASANA_API_BASE}/tasks/${encodeURIComponent(props.taskId)}?opt_fields=${TASK_FIELDS}`;
    return asanaGet<AsanaTask>(http, auth, url);
  },
});

/**
 * Update a task. Only the supplied fields change (Asana PUT is a partial update),
 * so omitted props are left as they are. `completed` marks a task done or reopened.
 */
export const updateTask = defineAction({
  type: UPDATE_TASK_TYPE,
  name: 'Update task',
  description: 'Update fields of an Asana task.',
  auth: asanaAuth,
  props: {
    taskId: shortText<true>({ label: 'Task id', required: true }),
    name: shortText({ label: 'Name', required: false }),
    notes: longText({ label: 'Notes', required: false }),
    completed: checkbox({ label: 'Completed', required: false }),
    assignee: shortText({ label: 'Assignee', description: 'User gid, or "me".', required: false }),
    dueOn: shortText({ label: 'Due date', description: 'YYYY-MM-DD.', required: false }),
  },
  async run({ auth, props, http }): Promise<AsanaTask> {
    const data: Record<string, JsonValue> = {};
    if (props.name !== undefined) data.name = props.name;
    if (props.notes !== undefined) data.notes = props.notes;
    if (props.completed !== undefined) data.completed = props.completed;
    if (props.assignee !== undefined) data.assignee = props.assignee;
    if (props.dueOn !== undefined) data.due_on = props.dueOn;
    const res = await http.put<{ data: AsanaTask }>(
      `${ASANA_API_BASE}/tasks/${encodeURIComponent(props.taskId)}`,
      { auth, query: { opt_fields: TASK_FIELDS }, body: { data } },
    );
    return res.data.data;
  },
});

/** List the tasks in a project (live picker), following Asana's `offset` cursor up to `limit`. */
export const listTasks = defineAction({
  type: LIST_TASKS_TYPE,
  name: 'List tasks',
  description: 'List the tasks in an Asana project.',
  auth: asanaAuth,
  props: {
    project: projectProp(true, 'List tasks from this project (loaded live).'),
    limit: number({ label: 'Max results', required: false, defaultValue: 100 }),
  },
  async run({ auth, props, http }): Promise<{ tasks: AsanaTask[]; count: number }> {
    const tasks = await paginate<AsanaTask>({
      http,
      auth,
      url: `${ASANA_API_BASE}/tasks`,
      query: { project: props.project, limit: 100, opt_fields: 'name,completed,due_on' },
      extractItems: (res) => (res.data as { data?: AsanaTask[] }).data ?? [],
      nextPage: cursorInBody({ cursorPath: ['next_page', 'offset'], cursorParam: 'offset' }),
      maxItems: props.limit ?? 100,
    });
    return { tasks, count: tasks.length };
  },
});

/** Add a comment (a "story") to a task. */
export const addComment = defineAction({
  type: ADD_COMMENT_TYPE,
  name: 'Add comment',
  description: 'Add a comment to an Asana task.',
  auth: asanaAuth,
  props: {
    taskId: shortText<true>({ label: 'Task id', required: true }),
    text: longText<true>({ label: 'Comment', required: true }),
  },
  async run({ auth, props, http }): Promise<AsanaStory> {
    const res = await http.post<{ data: AsanaStory }>(
      `${ASANA_API_BASE}/tasks/${encodeURIComponent(props.taskId)}/stories`,
      { auth, body: { data: { text: props.text } } },
    );
    return res.data.data;
  },
});
