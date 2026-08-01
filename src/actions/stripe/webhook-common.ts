import { createHmac, timingSafeEqual } from 'node:crypto';

import type { AuthHandle } from '../../core/auth';
import type { HttpClient } from '../../core/http/client';
import type { WebhookRegistration, WebhookRequest } from '../../core/trigger';
import { STRIPE_API_BASE } from './common';

/** The `POST /v1/webhook_endpoints` response — the id (to delete) and the signing secret. */
interface StripeWebhookEndpoint {
  id: string;
  secret?: string;
}

/** The Stripe Event envelope every webhook delivery carries; `data.object` is the resource that changed. */
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
 * Register a Stripe webhook endpoint for `event`; Stripe returns the signing secret only here,
 * so it must be captured into the {@link WebhookRegistration} for {@link verifyStripeSignature}.
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
 * Verify a `Stripe-Signature: t=…,v1=…` delivery (timing-safe); fails closed rather than throwing.
 * Replay is neutralised by the per-event dedupe, not a timestamp window.
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
