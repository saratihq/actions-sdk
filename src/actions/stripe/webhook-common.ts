import { createHmac, timingSafeEqual } from 'node:crypto';

import type { AuthHandle } from '../../core/auth';
import type { HttpClient } from '../../core/http/client';
import type { WebhookRegistration, WebhookRequest } from '../../core/trigger';
import { STRIPE_API_BASE } from './common';

/**
 * Shared plumbing for Stripe's REGISTERED-webhook triggers (`payment_succeeded`,
 * `new_customer`, …). Every one registers the SAME webhook-endpoint shape — only
 * the subscribed event and the payload transform differ — so the create/delete
 * API calls, the signature check, and the event envelope live here, authored once.
 *
 * Per Stripe's public webhook contract: `POST /v1/webhook_endpoints`
 * (form-encoded, `enabled_events[]`), the `secret` (`whsec_…`) it returns, and
 * the `Stripe-Signature: t=…,v1=…` HMAC-SHA256 scheme.
 * Docs: https://docs.stripe.com/api/webhook_endpoints/create and
 * https://docs.stripe.com/webhooks.md#verify-manually.
 */

/** The `POST /v1/webhook_endpoints` response — the id (to delete) and the signing secret. */
interface StripeWebhookEndpoint {
  id: string;
  secret?: string;
}

/**
 * The Stripe Event envelope every webhook delivery carries. `data.object` is the
 * resource that changed (a charge, a customer, …); generic over it so each
 * trigger narrows to its own resource shape.
 * Docs: https://docs.stripe.com/api/events/object.
 */
export interface StripeEvent<T> {
  id: string;
  object: 'event';
  type: string;
  created: number;
  livemode: boolean;
  data: { object: T };
}

/** Narrow an inbound webhook body to a Stripe event of the expected `type`, or null. */
export function asStripeEvent<T>(body: unknown, expectedType: string): StripeEvent<T> | null {
  if (typeof body !== 'object' || body === null) return null;
  const event = body as Partial<StripeEvent<T>>;
  if (event.object !== 'event' || event.type !== expectedType) return null;
  if (typeof event.id !== 'string' || typeof event.data !== 'object' || event.data === null) return null;
  return event as StripeEvent<T>;
}

/**
 * Register a Stripe webhook endpoint subscribed to `event`, pointed at the public
 * intake URL. Stripe GENERATES the signing secret and returns it only on creation
 * — so it is captured into the {@link WebhookRegistration} handle as
 * `signingSecret`; the runtime persists it verbatim and surfaces it back to
 * {@link verifyStripeSignature} (via the `verify` secrets bag as `signingSecret`)
 * on every inbound delivery.
 *
 * The body is `application/x-www-form-urlencoded` — Stripe's REST API takes no
 * JSON — so it uses the direct transport's `form` encoder (`enabled_events[0]=…`).
 */
export async function createStripeWebhookEndpoint(
  http: HttpClient,
  auth: AuthHandle,
  opts: { event: string; webhookUrl: string },
): Promise<WebhookRegistration> {
  const res = await http.post<StripeWebhookEndpoint>(`${STRIPE_API_BASE}/webhook_endpoints`, {
    auth,
    form: { url: opts.webhookUrl, enabled_events: [opts.event] },
  });
  return { subscriptionId: res.data.id, signingSecret: res.data.secret ?? '' };
}

/** Delete the webhook endpoint `registration` named. A 404 means it's already gone — teardown is idempotent. */
export async function deleteStripeWebhookEndpoint(
  http: HttpClient,
  auth: AuthHandle,
  registration?: WebhookRegistration,
): Promise<void> {
  if (!registration?.subscriptionId) return;
  const id = encodeURIComponent(registration.subscriptionId);
  const res = await http.delete(`${STRIPE_API_BASE}/webhook_endpoints/${id}`, {
    auth,
    throwOnError: false,
  });
  if (res.status !== 404 && (res.status < 200 || res.status >= 300)) {
    throw new Error(`Stripe webhook-endpoint delete failed: HTTP ${res.status}`);
  }
}

/**
 * Authenticate an inbound delivery with the endpoint's signing secret before
 * trusting the payload. Stripe signs `${t}.${rawBody}` (the `t=` timestamp from
 * the header, a literal dot, then the exact received bytes) with HMAC-SHA256 and
 * sends the hex digest as the `v1` scheme in `Stripe-Signature: t=…,v1=…`.
 * Comparison is timing-safe. Returns false (never throws) for any missing/malformed
 * input — a spoofed or unsigned request must fail closed.
 *
 * Replay is neutralised by the per-event dedupe (`evt_…`), not a timestamp window,
 * so no clock-skew rejection is enforced here.
 */
export function verifyStripeSignature(request: WebhookRequest, secrets: Record<string, string>): boolean {
  const secret = secrets.signingSecret;
  if (!secret || request.rawBody === undefined) return false;
  const header = request.headers['stripe-signature'];
  if (!header) return false;

  const parsed = parseStripeSignatureHeader(header);
  if (!parsed) return false;

  const expected = createHmac('sha256', secret).update(`${parsed.t}.${request.rawBody}`).digest('hex');
  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(parsed.v1);
  return expectedBuf.length === actualBuf.length && timingSafeEqual(expectedBuf, actualBuf);
}

/** Parse `t=…,v1=…[,v0=…]` into its timestamp and v1 signature; null if either is absent. */
function parseStripeSignatureHeader(header: string): { t: string; v1: string } | null {
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

/** Sign a body the way Stripe would — used by tests to forge a correctly-signed delivery. */
export function signStripeBody(rawBody: string, timestamp: string, secret: string): string {
  const v1 = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  return `t=${timestamp},v1=${v1}`;
}
