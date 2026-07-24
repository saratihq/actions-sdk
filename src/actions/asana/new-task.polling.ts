import { defineTrigger } from '../../core/trigger';
import { paginate, cursorInBody } from '../../core/http/pagination';
import { ASANA_API_BASE, type AsanaTask, asanaAuth, projectProp } from './common';

/**
 * Polling trigger (`asana.new_task`) — fires for each new task in a project.
 *
 * WHY POLLING (not a registered webhook): Asana webhooks require a two-step
 * handshake where Asana POSTs an empty request carrying an `X-Hook-Secret` header
 * that the receiver must echo back **in a response header**, and the signing
 * secret is delivered ONLY via that handshake (never in the create response). The
 * SDK's `HandshakeResponse` ({ status, body }) can echo a body (Slack-style) but
 * cannot set a response header, so Asana's handshake can't complete within this
 * contract. Docs: https://developer.asana.com/docs/establishing-a-webhook —
 * polling works identically on both the managed and BYO transports.
 *
 * WINDOWING (correctness): `GET /tasks?project=` returns the project's tasks in
 * board/list position order — NOT creation order — includes completed tasks, and
 * the SDK caps the walk at {@link MAX_ITEMS}. So a freshly-created task can sit
 * beyond that window and never be seen. Asana's public contract lets a poll ask
 * for only what changed: `modified_since` (ISO 8601) restricts the response to
 * tasks modified at/after that instant, and a creation counts as a modification —
 * so a new task always comes back regardless of its list position or the cap. The
 * SDK passes the last-poll watermark as `modified_since` and keeps the gid dedupe
 * (a task edited after it first fired is windowed back in, but its gid is already
 * seen).
 * Docs: https://developers.asana.com/reference/gettasksforproject
 *
 * FIRST POLL (self-baseline): with no watermark yet, `modified_since` is unknown,
 * so emitting the current window would fire every pre-existing task as if new. The
 * first poll instead baselines silently — it returns nothing and the runtime
 * records the watermark after it, so only tasks changed *after* enablement fire.
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
    // First poll: no watermark to window on yet. Baseline silently — the runtime
    // records the watermark after this poll, so only tasks changed afterwards fire.
    if (lastPolledAt === undefined) return [];

    return paginate<AsanaTask>({
      http,
      auth,
      url: `${ASANA_API_BASE}/tasks`,
      // `modified_since` (ISO 8601) returns only tasks changed since the last poll,
      // so a new task comes back regardless of list position or the item cap.
      query: { project: props.project, modified_since: lastPolledAt, limit: 100, opt_fields: TASK_FIELDS },
      extractItems: (res) => (res.data as { data?: AsanaTask[] }).data ?? [],
      nextPage: cursorInBody({ cursorPath: ['next_page', 'offset'], cursorParam: 'offset' }),
      maxItems: MAX_ITEMS,
    });
  },
  dedupeKey: (task) => task.gid,
});
