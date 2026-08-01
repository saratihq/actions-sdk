import { defineTrigger } from '../../core/trigger';
import { paginate, cursorInBody } from '../../core/http/pagination';
import { ASANA_API_BASE, type AsanaTask, asanaAuth, projectProp } from './common';

/**
 * Fires for each new task in a project. Polling, not webhooks: Asana's handshake needs an
 * `X-Hook-Secret` response HEADER, which the SDK's `HandshakeResponse` cannot set.
 */

export const NEW_TASK_TYPE = 'asana.new_task';

/** The task fields requested back — trimmed to what workflows use. */
const TASK_FIELDS = 'name,created_at,completed,permalink_url,assignee.name';

/** Cap the per-poll walk so a huge project can't fetch unbounded pages each tick. */
const MAX_ITEMS = 200;

export const newTask = defineTrigger({
  type: NEW_TASK_TYPE,
  strategy: 'polling',
  name: 'New task',
  description: 'Fires when a task is added to an Asana project.',
  auth: asanaAuth,
  props: {
    project: projectProp(true, 'Watch this project for new tasks (loaded live).'),
  },
  sampleData: {
    gid: '1201234567890123',
    name: 'Draft the launch checklist',
    created_at: '2025-01-24T14:32:18.076Z',
    completed: false,
    permalink_url: 'https://app.asana.com/0/1201234567890123/1209876543210987',
    assignee: { gid: '1200000000000001', name: 'Sarah Chen' },
  },
  async poll({ auth, props, http, lastPolledAt }): Promise<AsanaTask[]> {
    // First poll baselines silently; emitting the current window would fire every pre-existing task.
    if (lastPolledAt === undefined) return [];

    return paginate<AsanaTask>({
      http,
      auth,
      url: `${ASANA_API_BASE}/tasks`,
      // `modified_since` is load-bearing: /tasks returns list-position order, so a new task would
      // otherwise sit beyond the item cap and never be seen.
      query: { project: props.project, modified_since: lastPolledAt, limit: 100, opt_fields: TASK_FIELDS },
      extractItems: (res) => (res.data as { data?: AsanaTask[] }).data ?? [],
      nextPage: cursorInBody({ cursorPath: ['next_page', 'offset'], cursorParam: 'offset' }),
      maxItems: MAX_ITEMS,
    });
  },
  dedupeKey: (task) => task.gid,
});
