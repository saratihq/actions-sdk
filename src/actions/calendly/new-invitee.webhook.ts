import { createHmac, timingSafeEqual } from 'node:crypto';

import { defineTrigger, type WebhookRegistration, type WebhookRequest } from '../../core/trigger';
import { CALENDLY_API_BASE, calendlyAuth, getCurrentUser, uuidFromUri } from './common';

/** Public type for the registered-webhook trigger. */
export const NEW_INVITEE_TYPE = 'calendly.new_invitee';

/** The Calendly event this trigger subscribes to. */
const EVENT = 'invitee.created';

/**
 * A REGISTERED webhook trigger for new Calendly bookings. Per Calendly's API v2:
 *  - register: `POST /webhook_subscriptions` with
 *    `{ url, events: ['invitee.created'], organization, user, scope: 'user', signing_key }`
 *    (https://developer.calendly.com/api-docs/b3A6NTkxNDI1-create-webhook-subscription);
 *  - deliveries are signed `Calendly-Webhook-Signature: t=…,v1=…` — HMAC-SHA256
 *    hex of `${t}.${rawBody}` under the `signing_key`
 *    (https://developer.calendly.com/api-docs/4c305798a61d3-webhook-signatures);
 *  - the body is `{ event: 'invitee.created', created_at, payload: {…invitee…} }`
 *    where the invitee fields sit DIRECTLY on `payload` (with a nested
 *    `scheduled_event`).
 *
 * The SDK supplies the `signing_key`. The subscription is scoped to the
 * connected user, resolved from `/users/me` (its `uri` + `current_organization`).
 */

/** The invitee resource Calendly puts directly on the webhook `payload` (fields we read). */
interface CalendlyInviteePayload {
  uri?: string;
  email?: string;
  name?: string;
  status?: string;
  timezone?: string;
  /** The scheduled-event URI this invitee booked. */
  event?: string;
  cancel_url?: string;
  reschedule_url?: string;
  questions_and_answers?: Array<{ question?: string; answer?: string; position?: number }>;
  scheduled_event?: {
    uri?: string;
    name?: string;
    status?: string;
    start_time?: string;
    end_time?: string;
    event_type?: string;
  };
}

/** The webhook envelope (the relevant fields). */
interface CalendlyWebhookBody {
  event?: string;
  created_at?: string;
  payload?: CalendlyInviteePayload;
}

/** A normalised new-invitee event — what a workflow step receives. Trimmed to the fields workflows use. */
export interface CalendlyInviteeEvent {
  /** The invitee URI — unique per booking; the delivery-dedup key. */
  inviteeUri: string;
  email: string;
  name: string;
  status: string;
  timezone?: string;
  /** The scheduled-event URI. */
  eventUri?: string;
  eventName?: string;
  startTime?: string;
  endTime?: string;
  cancelUrl?: string;
  rescheduleUrl?: string;
  questionsAndAnswers: Array<{ question: string; answer: string }>;
  /** ISO timestamp the event was created. */
  createdAt?: string;
}

export const newInvitee = defineTrigger({
  type: NEW_INVITEE_TYPE,
  strategy: 'webhook',
  name: 'New invitee',
  description: 'Fires when an invitee books a Calendly meeting.',
  auth: calendlyAuth,
  props: {},
  sampleData: {
    inviteeUri: 'https://api.calendly.com/scheduled_events/EVENT_UUID/invitees/INVITEE_UUID',
    email: 'invitee@example.com',
    name: 'John Doe',
    status: 'active',
    timezone: 'America/New_York',
    eventUri: 'https://api.calendly.com/scheduled_events/EVENT_UUID',
    eventName: '15 Minute Meeting',
    startTime: '2026-07-24T14:00:00.000000Z',
    endTime: '2026-07-24T14:15:00.000000Z',
    cancelUrl: 'https://calendly.com/cancellations/INVITEE_UUID',
    rescheduleUrl: 'https://calendly.com/reschedulings/INVITEE_UUID',
    questionsAndAnswers: [{ question: 'What would you like to discuss?', answer: 'Onboarding' }],
    createdAt: '2026-07-20T17:51:19.000000Z',
  },
  /**
   * Register a user-scoped webhook subscription for `invitee.created`, pointed at
   * the intake URL and signed with `secret`. Resolves the connected user + org itself.
   */
  async onEnable({ http, auth, webhookUrl, secret }): Promise<WebhookRegistration> {
    const user = await getCurrentUser(http, auth);
    const res = await http.post<{ resource: { uri: string } }>(`${CALENDLY_API_BASE}/webhook_subscriptions`, {
      auth,
      body: {
        url: webhookUrl,
        events: [EVENT],
        organization: user.current_organization,
        user: user.uri,
        scope: 'user',
        signing_key: secret,
      },
    });
    return { subscriptionId: uuidFromUri(res.data.resource.uri) };
  },
  /** Delete the subscription by its uuid. A 404 means it's already gone — teardown is idempotent. */
  async onDisable({ http, auth, registration }): Promise<void> {
    if (!registration?.subscriptionId) return;
    const uuid = encodeURIComponent(registration.subscriptionId);
    const res = await http.delete(`${CALENDLY_API_BASE}/webhook_subscriptions/${uuid}`, {
      auth,
      throwOnError: false,
    });
    if (res.status !== 404 && (res.status < 200 || res.status >= 300)) {
      throw new Error(`Calendly webhook-subscription delete failed: HTTP ${res.status}`);
    }
  },
  /** Authenticate the delivery: hex HMAC-SHA256 of `${t}.${rawBody}` under the signing key, `v1` scheme. */
  verify(request: WebhookRequest, secrets: Record<string, string>): boolean {
    const secret = secrets.signingSecret;
    if (!secret || request.rawBody === undefined) return false;
    const header = request.headers['calendly-webhook-signature'];
    if (!header) return false;
    const parsed = parseCalendlySignature(header);
    if (!parsed) return false;
    const expected = createHmac('sha256', secret).update(`${parsed.t}.${request.rawBody}`).digest('hex');
    const expectedBuf = Buffer.from(expected);
    const actualBuf = Buffer.from(parsed.v1);
    return expectedBuf.length === actualBuf.length && timingSafeEqual(expectedBuf, actualBuf);
  },
  onRequest({ request }): CalendlyInviteeEvent[] {
    const body = request.body as CalendlyWebhookBody | undefined;
    if (!body || body.event !== EVENT) return [];
    const invitee = body.payload;
    if (!invitee || typeof invitee.uri !== 'string') return [];
    const scheduled = invitee.scheduled_event;
    return [
      {
        inviteeUri: invitee.uri,
        email: invitee.email ?? '',
        name: invitee.name ?? '',
        status: invitee.status ?? '',
        ...(invitee.timezone ? { timezone: invitee.timezone } : {}),
        ...(invitee.event ? { eventUri: invitee.event } : {}),
        ...(scheduled?.name ? { eventName: scheduled.name } : {}),
        ...(scheduled?.start_time ? { startTime: scheduled.start_time } : {}),
        ...(scheduled?.end_time ? { endTime: scheduled.end_time } : {}),
        ...(invitee.cancel_url ? { cancelUrl: invitee.cancel_url } : {}),
        ...(invitee.reschedule_url ? { rescheduleUrl: invitee.reschedule_url } : {}),
        questionsAndAnswers: (invitee.questions_and_answers ?? [])
          .filter((qa) => typeof qa.question === 'string')
          .map((qa) => ({ question: qa.question ?? '', answer: qa.answer ?? '' })),
        ...(body.created_at ? { createdAt: body.created_at } : {}),
      },
    ];
  },
  /** Calendly may redeliver; the invitee URI is unique per booking — dedupe on it. */
  dedupeKey: (event) => event.inviteeUri,
});

/** Parse `t=…,v1=…` into its timestamp and v1 signature; null if either is absent. */
function parseCalendlySignature(header: string): { t: string; v1: string } | null {
  let t: string | undefined;
  let v1: string | undefined;
  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === 't') t = value;
    else if (key === 'v1') v1 = value;
  }
  return t && v1 ? { t, v1 } : null;
}

/** Sign a body the way Calendly would — used by tests to forge a correctly-signed delivery. */
export function signCalendlyBody(rawBody: string, timestamp: string, secret: string): string {
  const v1 = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  return `t=${timestamp},v1=${v1}`;
}
