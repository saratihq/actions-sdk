import { createHmac, timingSafeEqual } from 'node:crypto';

import type { WebhookRequest } from '../../core/trigger';

/**
 * Verify a GitHub webhook signature (the `sha256` scheme). GitHub signs the
 * raw request body with the hook's shared secret and sends the result as
 * `X-Hub-Signature-256: sha256=<hex>`. Comparison is timing-safe. Returns false
 * (never throws) for any missing/malformed input — a spoofed or unsigned
 * request must fail closed, not crash into a different code path.
 *
 * Unlike Slack, GitHub sends no timestamp, so there is no replay window to
 * enforce here; the shared secret + per-delivery `X-GitHub-Delivery` dedup is
 * the protection the contract relies on.
 */
export function verifyGithubSignature(request: WebhookRequest, secret: string): boolean {
  if (!secret) return false;
  const signature = request.headers['x-hub-signature-256'];
  if (!signature || request.rawBody === undefined) return false;

  const expected = signGithubBody(request.rawBody, secret);
  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(signature);
  return expectedBuf.length === actualBuf.length && timingSafeEqual(expectedBuf, actualBuf);
}

/** Produce the `sha256=<hex>` header value GitHub would send — used by tests and by verify. */
export function signGithubBody(rawBody: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}
