import { createHmac, timingSafeEqual } from 'node:crypto';

import type { WebhookRequest } from '../../core/trigger';

/** Default replay window: Slack recommends rejecting requests older than 5 minutes. */
const DEFAULT_TOLERANCE_SEC = 60 * 5;

/**
 * Verify a Slack request signature (the `v0` scheme). The signature base string
 * is `v0:{timestamp}:{rawBody}`, HMAC-SHA256 with the app signing secret, hex,
 * prefixed `v0=`. Comparison is timing-safe; stale timestamps are rejected to
 * defeat replays. Returns false (never throws) for any missing/malformed input,
 * so a spoofed request can't crash the handler into a different code path.
 */
export function verifySlackSignature(
  request: WebhookRequest,
  signingSecret: string,
  options: { nowMs?: number; toleranceSec?: number } = {},
): boolean {
  if (!signingSecret) return false;
  const timestamp = request.headers['x-slack-request-timestamp'];
  const signature = request.headers['x-slack-signature'];
  if (!timestamp || !signature || request.rawBody === undefined) return false;

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  const nowSec = (options.nowMs ?? Date.now()) / 1000;
  const tolerance = options.toleranceSec ?? DEFAULT_TOLERANCE_SEC;
  if (Math.abs(nowSec - ts) > tolerance) return false;

  const base = `v0:${timestamp}:${request.rawBody}`;
  const expected = `v0=${createHmac('sha256', signingSecret).update(base).digest('hex')}`;
  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(signature);
  return expectedBuf.length === actualBuf.length && timingSafeEqual(expectedBuf, actualBuf);
}

/** Sign a payload the way Slack would — used by tests to produce a valid vector. */
export function signSlackRequest(rawBody: string, signingSecret: string, timestamp: string): string {
  return `v0=${createHmac('sha256', signingSecret).update(`v0:${timestamp}:${rawBody}`).digest('hex')}`;
}
