import { createHmac, timingSafeEqual } from 'node:crypto';

import { ActionError } from '../../core/errors';
import { dropdown } from '../../core/props';
import { defineTrigger, type WebhookRegistration, type WebhookRequest } from '../../core/trigger';
import { linearAuth, linearGraphql, teamOptions } from './common';

/** Registered-webhook trigger for the `Issue` resource — one subscription covers create/update/remove. */
export const NEW_ISSUE_TYPE = 'linear.new_issue';

/** The store key the provider-generated signing secret is persisted under (per trigger). */
const SIGNING_SECRET_KEY = 'signingSecret';

/** A normalised Linear issue event — trimmed to the fields workflows use. */
export interface LinearIssueEvent {
  /** `create` | `update` | `remove`. */
  action: string;
  /** The issue's UUID (`data.id`). */
  issueId: string;
  title: string;
  /** The issue's web URL. */
  url: string;
  /** Sequential number within the team (`data.number`). */
  number?: number;
  /** Linear priority 0–4. */
  priority?: number;
  teamId?: string;
  stateId?: string;
  /** Who performed the action (`actor.name`). */
  actor?: string;
  /** Unix-ms send time — stable across provider retries, so it anchors dedup. */
  webhookTimestamp?: number;
}

/** The Linear webhook envelope (the relevant fields). */
interface LinearWebhookPayload {
  action?: string;
  type?: string;
  url?: string;
  webhookTimestamp?: number;
  actor?: { name?: string };
  data?: {
    id?: string;
    title?: string;
    number?: number;
    priority?: number;
    teamId?: string;
    stateId?: string;
    url?: string;
  };
}

interface WebhookCreatePayload {
  webhookCreate: { success: boolean; webhook: { id: string; enabled: boolean; secret: string } };
}

const WEBHOOK_CREATE = `mutation WebhookCreate($input: WebhookCreateInput!) {
  webhookCreate(input: $input) { success webhook { id enabled secret } }
}`;

const WEBHOOK_DELETE = `mutation WebhookDelete($id: String!) { webhookDelete(id: $id) { success } }`;

/** Timing-safe compare of the `Linear-Signature` hex HMAC-SHA256 over the raw body. */
function verifyLinearSignature(request: WebhookRequest, secret: string): boolean {
  if (!secret) return false;
  const signature = request.headers['linear-signature'];
  if (!signature || request.rawBody === undefined) return false;
  const expected = createHmac('sha256', secret).update(request.rawBody).digest('hex');
  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(signature);
  return expectedBuf.length === actualBuf.length && timingSafeEqual(expectedBuf, actualBuf);
}

export const newIssue = defineTrigger({
  type: NEW_ISSUE_TYPE,
  strategy: 'webhook',
  name: 'New issue',
  description: 'Fires when an issue is created or updated in Linear.',
  auth: linearAuth,
  props: {
    teamId: dropdown<string, false>({
      label: 'Team',
      description: 'Restrict to one team (loaded live). Leave empty to watch all public teams.',
      required: false,
      options: ({ auth, http }) => teamOptions(http, auth),
    }),
  },
  sampleData: {
    action: 'create',
    issueId: '8f7e6d5c-4b3a-2198-7f6e-5d4c3b2a1098',
    title: 'Add user authentication to API endpoints',
    url: 'https://linear.app/company/issue/ENG-123',
    number: 123,
    priority: 1,
    teamId: '72b2a2dc-6f4f-4423-9d34-24b5bd10634a',
    stateId: 'e3d2c1b0-a987-6f5e-4d3c-2b1a09876543',
    actor: 'Sarah Chen',
    webhookTimestamp: 1706107938084,
  },
  /** Register the webhook and persist the secret Linear mints, so `onRequest` can verify deliveries. */
  async onEnable({ http, auth, props, webhookUrl, store }): Promise<WebhookRegistration> {
    const input: Record<string, unknown> = {
      url: webhookUrl,
      resourceTypes: ['Issue'],
      label: 'Sarati',
    };
    if (props.teamId !== undefined) input.teamId = props.teamId;
    else input.allPublicTeams = true;

    const data = await linearGraphql<WebhookCreatePayload>(http, auth, WEBHOOK_CREATE, { input });
    const { id, secret } = data.webhookCreate.webhook;
    await store.set(SIGNING_SECRET_KEY, secret);
    return { subscriptionId: id, signingSecret: secret };
  },
  /** Delete the Linear webhook. Any error (already gone) is swallowed — teardown is idempotent. */
  async onDisable({ http, auth, registration }): Promise<void> {
    const id = registration?.subscriptionId;
    if (!id) return;
    try {
      await linearGraphql(http, auth, WEBHOOK_DELETE, { id });
    } catch {
      // Already deleted / not found — teardown is best-effort idempotent.
    }
  },
  /** Verification lives here, not in `verify`: the provider-minted secret is only reachable via the store. */
  async onRequest({ request, store }): Promise<LinearIssueEvent[]> {
    const secret = await store.get<string>(SIGNING_SECRET_KEY);
    if (!secret || !verifyLinearSignature(request, secret)) {
      throw new ActionError({
        code: 'provider_error',
        message: 'Linear webhook signature verification failed',
        status: 401,
        retryable: false,
      });
    }

    const body = request.body as LinearWebhookPayload | undefined;
    // Only `Issue` was subscribed; ignore anything else defensively.
    if (!body || body.type !== 'Issue') return [];
    const issue = body.data;
    if (!issue || typeof issue.id !== 'string') return [];

    return [
      {
        action: body.action ?? '',
        issueId: issue.id,
        title: issue.title ?? '',
        url: body.url ?? issue.url ?? '',
        ...(typeof issue.number === 'number' ? { number: issue.number } : {}),
        ...(typeof issue.priority === 'number' ? { priority: issue.priority } : {}),
        ...(issue.teamId ? { teamId: issue.teamId } : {}),
        ...(issue.stateId ? { stateId: issue.stateId } : {}),
        ...(body.actor?.name ? { actor: body.actor.name } : {}),
        ...(typeof body.webhookTimestamp === 'number' ? { webhookTimestamp: body.webhookTimestamp } : {}),
      },
    ];
  },
  /** Linear carries no per-delivery id; the send timestamp is stable across retries. */
  dedupeKey: (event) => `${event.issueId}:${event.action}:${event.webhookTimestamp ?? ''}`,
});
