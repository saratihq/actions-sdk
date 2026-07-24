import type { WebhookRequest } from '../../core/trigger';
import { signSlackRequest, verifySlackSignature } from './signature';

const SECRET = 'shhh-signing-secret';

function requestFor(rawBody: string, timestamp: string, signature: string): WebhookRequest {
  return {
    headers: { 'x-slack-request-timestamp': timestamp, 'x-slack-signature': signature },
    body: JSON.parse(rawBody),
    rawBody,
  };
}

describe('verifySlackSignature', () => {
  const rawBody = JSON.stringify({ type: 'event_callback', event: { type: 'message' } });
  const nowMs = 1_700_000_000_000;
  const ts = String(Math.floor(nowMs / 1000));

  it('accepts a correctly-signed, fresh request', () => {
    const sig = signSlackRequest(rawBody, SECRET, ts);
    expect(verifySlackSignature(requestFor(rawBody, ts, sig), SECRET, { nowMs })).toBe(true);
  });

  it('rejects a wrong signing secret', () => {
    const sig = signSlackRequest(rawBody, 'other-secret', ts);
    expect(verifySlackSignature(requestFor(rawBody, ts, sig), SECRET, { nowMs })).toBe(false);
  });

  it('rejects a tampered body', () => {
    const sig = signSlackRequest(rawBody, SECRET, ts);
    const tampered = requestFor(JSON.stringify({ type: 'evil' }), ts, sig);
    expect(verifySlackSignature(tampered, SECRET, { nowMs })).toBe(false);
  });

  it('rejects a stale timestamp (replay guard)', () => {
    const sig = signSlackRequest(rawBody, SECRET, ts);
    const laterMs = nowMs + 1000 * 60 * 10; // 10 minutes later
    expect(verifySlackSignature(requestFor(rawBody, ts, sig), SECRET, { nowMs: laterMs })).toBe(false);
  });

  it('rejects missing headers or rawBody', () => {
    expect(verifySlackSignature({ headers: {}, body: {} }, SECRET)).toBe(false);
    expect(verifySlackSignature({ headers: { 'x-slack-signature': 'v0=x' }, body: {} }, SECRET)).toBe(false);
  });
});
