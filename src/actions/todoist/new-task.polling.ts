import { defineTrigger } from '../../core/trigger';
import { paginate } from '../../core/http/pagination';
import {
  TODOIST_API_BASE,
  type TodoistPage,
  type TodoistTask,
  projectProp,
  todoistAuth,
  todoistNextPage,
} from './common';

/** Polling trigger (`todoist.new_task`) — fires for each new active task; Todoist has no per-connection webhook to register. */
export const NEW_TASK_TYPE = 'todoist.new_task';

/** Cap the per-poll walk so a huge task list can't fetch unbounded pages each tick. */
const MAX_ITEMS = 200;

export const newTask = defineTrigger({
  type: NEW_TASK_TYPE,
  strategy: 'polling',
  name: 'New task',
  description: 'Fires when a task is added in Todoist.',
  auth: todoistAuth,
  props: {
    project: projectProp(false, 'Restrict to this project (loaded live); omit to watch all tasks.'),
  },
  sampleData: {
    id: '2995104339',
    content: 'Draft the launch checklist',
    description: '',
    project_id: '2203306141',
    priority: 4,
    is_completed: false,
    url: 'https://todoist.com/showTask?id=2995104339',
    due: { date: '2025-01-25', string: 'tomorrow' },
    labels: ['launch'],
  },
  async poll({ auth, props, http }): Promise<TodoistTask[]> {
    return paginate<TodoistTask>({
      auth,
      http,
      url: `${TODOIST_API_BASE}/tasks`,
      query: { project_id: props.project },
      extractItems: (res) => (res.data as TodoistPage<TodoistTask>)?.results ?? [],
      nextPage: todoistNextPage,
      maxItems: MAX_ITEMS,
    });
  },
  dedupeKey: (task) => task.id,
});
