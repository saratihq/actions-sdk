import { createHmac, timingSafeEqual } from 'node:crypto';

import type { WebhookRequest } from '../../core/trigger';

/**
 * Verify `X-Hub-Signature-256` (timing-safe). Returns false, never throws, on any malformed input —
 * an unsigned or spoofed request must fail CLOSED.
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
