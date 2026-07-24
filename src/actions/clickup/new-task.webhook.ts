import { createHmac, timingSafeEqual } from 'node:crypto';

import { ActionError } from '../../core/errors';
import type { JsonValue } from '../../core/http/types';
import { dropdown } from '../../core/props';
import { defineTrigger, type WebhookRegistration, type WebhookRequest } from '../../core/trigger';
import { CLICKUP_API_BASE, type ClickupTask, clickupAuth, listOptions, listTeams } from './common';

/** Public type for the registered-webhook trigger. */
export const NEW_TASK_TYPE = 'clickup.new_task';

/**
 * A REGISTERED webhook trigger for ClickUp task creation. ClickUp registers a
 * webhook per workspace ("team") via the public API and **mints the signing
 * secret itself** (returned in the create response) — so `onEnable` persists
 * that secret to the trigger store and `onRequest` verifies the `X-Signature`
 * HMAC against it before trusting the payload.
 *
 * ClickUp's `taskCreated` delivery carries only `task_id` (not the task body), so
 * the transform fetches the task to hand workflows a useful, trimmed event.
 *
 * Docs: https://developer.clickup.com/reference/createwebhook +
 *       https://developer.clickup.com/docs/webhooksignature
 *  - POST /api/v2/team/{team_id}/webhook { endpoint, events, list_id? } → { id, webhook { id, secret } }
 *  - `X-Signature`: hex HMAC-SHA256 of the RAW body, keyed by the returned secret (no prefix)
 *  - DELETE /api/v2/webhook/{webhook_id}
 */

/** The store key the provider-generated signing secret is persisted under (per trigger). */
const SIGNING_SECRET_KEY = 'signingSecret';

/** A normalised ClickUp task-created event — trimmed to the fields workflows use. */
export interface ClickupTaskEvent {
  /** Always `taskCreated` for this trigger. */
  event: string;
  taskId: string;
  webhookId?: string;
  /** Enriched from a follow-up task fetch (absent if the fetch was unavailable). */
  name?: string;
  status?: string;
  url?: string;
}

/** The ClickUp webhook envelope (the relevant fields). */
interface ClickupWebhookPayload {
  event?: string;
  task_id?: string;
  webhook_id?: string;
}

/** The create-webhook response: a top-level id plus the webhook object carrying the secret. */
interface CreateWebhookResponse {
  id?: string;
  webhook?: { id?: string; secret?: string };
  secret?: string;
}

/** Timing-safe compare of the `X-Signature` hex HMAC-SHA256 over the raw body. */
function verifyClickupSignature(request: WebhookRequest, secret: string): boolean {
  if (!secret) return false;
  const signature = request.headers['x-signature'];
  if (!signature || request.rawBody === undefined) return false;
  const expected = createHmac('sha256', secret).update(request.rawBody).digest('hex');
  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(signature);
  return expectedBuf.length === actualBuf.length && timingSafeEqual(expectedBuf, actualBuf);
}

/** Normalise ClickUp's `status` (an object or a bare string) to a plain status name. */
function statusName(status: ClickupTask['status']): string | undefined {
  if (typeof status === 'string') return status;
  return status?.status;
}

export const newTask = defineTrigger({
  type: NEW_TASK_TYPE,
  strategy: 'webhook',
  name: 'New task',
  description: 'Fires when a task is created in a ClickUp workspace.',
  auth: clickupAuth,
  props: {
    teamId: dropdown<string, true>({
      label: 'Workspace',
      description: 'The ClickUp workspace (team) to watch — loaded live.',
      required: true,
      options: async ({ auth, http }) => {
        const teams = await listTeams(http, auth);
        return teams.map((t) => ({ label: t.name, value: t.id }));
      },
    }),
    listId: dropdown<string, false>({
      label: 'List',
      description: 'Restrict to one list (loaded live). Leave empty to watch the whole workspace.',
      required: false,
      options: ({ auth, http }) => listOptions(http, auth),
    }),
  },
  sampleData: {
    event: 'taskCreated',
    taskId: '9hz',
    webhookId: '4b67ac88-2bb7-4b1a-8f0a-7c9f8e6d5c4b',
    name: 'Draft the launch checklist',
    status: 'to do',
    url: 'https://app.clickup.com/t/9hz',
  },
  /**
   * Register a team-level webhook subscribed to `taskCreated` (optionally scoped to
   * one list), then persist the secret ClickUp returns for later verification.
   */
  async onEnable({ http, auth, props, webhookUrl, store }): Promise<WebhookRegistration> {
    const body: Record<string, JsonValue> = { endpoint: webhookUrl, events: ['taskCreated'] };
    if (props.listId !== undefined) body.list_id = props.listId;
    const res = await http.post<CreateWebhookResponse>(
      `${CLICKUP_API_BASE}/team/${encodeURIComponent(props.teamId)}/webhook`,
      { auth, body },
    );
    const id = res.data.webhook?.id ?? res.data.id;
    const secret = res.data.webhook?.secret ?? res.data.secret;
    if (!id || !secret) {
      throw new ActionError({
        code: 'provider_error',
        message: 'ClickUp did not return a webhook id and secret on creation',
        status: 502,
        retryable: false,
      });
    }
    await store.set(SIGNING_SECRET_KEY, secret);
    return { subscriptionId: id, signingSecret: secret };
  },
  /** Delete the webhook. A 404 means it's already gone — teardown is idempotent. */
  async onDisable({ http, auth, registration }): Promise<void> {
    const id = registration?.subscriptionId;
    if (!id) return;
    const res = await http.delete(`${CLICKUP_API_BASE}/webhook/${encodeURIComponent(id)}`, {
      auth,
      throwOnError: false,
    });
    if (res.status !== 404 && (res.status < 200 || res.status >= 300)) {
      throw new Error(`ClickUp webhook delete failed: HTTP ${res.status}`);
    }
  },
  /**
   * Verify the `X-Signature` HMAC against the persisted secret, then transform.
   * Verification lives here (not in `verify`) because the secret is provider-minted
   * and read from the trigger store, which `verify` has no access to. ClickUp's
   * payload carries only `task_id`, so the task is fetched to enrich the event.
   */
  async onRequest({ request, store, http, auth }): Promise<ClickupTaskEvent[]> {
    const secret = await store.get<string>(SIGNING_SECRET_KEY);
    if (!secret || !verifyClickupSignature(request, secret)) {
      throw new ActionError({
        code: 'provider_error',
        message: 'ClickUp webhook signature verification failed',
        status: 401,
        retryable: false,
      });
    }

    const body = request.body as ClickupWebhookPayload | undefined;
    if (!body || body.event !== 'taskCreated' || typeof body.task_id !== 'string') return [];
    const taskId = body.task_id;

    const event: ClickupTaskEvent = {
      event: body.event,
      taskId,
      ...(body.webhook_id ? { webhookId: body.webhook_id } : {}),
    };

    // Enrich from the task itself (the delivery has no task body). Best-effort: a
    // failed/absent fetch still fires the event with the id workflows can act on.
    const task = await http.get<ClickupTask>(`${CLICKUP_API_BASE}/task/${encodeURIComponent(taskId)}`, {
      auth,
      throwOnError: false,
    });
    if (task.status >= 200 && task.status < 300) {
      if (task.data.name) event.name = task.data.name;
      const status = statusName(task.data.status);
      if (status) event.status = status;
      if (task.data.url) event.url = task.data.url;
    }
    return [event];
  },
  /** One `taskCreated` per task; the task id is the natural retry-dedup key. */
  dedupeKey: (event) => `task:${event.taskId}`,
});
