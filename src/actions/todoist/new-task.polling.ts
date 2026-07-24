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

/**
 * Polling trigger (`todoist.new_task`) — fires for each new active task.
 *
 * WHY POLLING (not a registered webhook): Todoist webhooks are configured **at the
 * app level** in the Developer Console — one URL per OAuth app, signed by the
 * app's single `client_secret` and firing for every user who authorised the app.
 * There is no public API to register a webhook with a per-connection URL or a
 * per-connection secret, so the register/verify-per-connection shape the SDK
 * webhook transport needs doesn't exist. Docs: https://developer.todoist.com/sync/v9/
 * (Webhooks). Polling works identically on both the managed and BYO transports.
 *
 * The poll lists active tasks (optionally scoped to a project); the SDK's
 * `runPoll` dedupes by task id, so a re-poll emits only tasks not seen before.
 */

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
