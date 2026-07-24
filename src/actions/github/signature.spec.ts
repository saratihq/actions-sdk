import type { WebhookRequest } from '../../core/trigger';
import { signGithubBody, verifyGithubSignature } from './signature';

const SECRET = 'top-secret-webhook-key';

function request(rawBody: string, signature?: string): WebhookRequest {
  return {
    headers: signature ? { 'x-hub-signature-256': signature } : {},
    body: JSON.parse(rawBody) as unknown,
    rawBody,
  };
}

describe('verifyGithubSignature', () => {
  const rawBody = JSON.stringify({ ref: 'refs/heads/main', after: 'abc123' });

  it('accepts a signature computed the way GitHub computes it', () => {
    const sig = signGithubBody(rawBody, SECRET);
    expect(verifyGithubSignature(request(rawBody, sig), SECRET)).toBe(true);
  });

  it('rejects a tampered body (signature no longer matches)', () => {
    const sig = signGithubBody(rawBody, SECRET);
    const tampered = request(JSON.stringify({ ref: 'refs/heads/main', after: 'DEADBEEF' }), sig);
    expect(verifyGithubSignature(tampered, SECRET)).toBe(false);
  });

  it('rejects a signature made with the wrong secret', () => {
    const sig = signGithubBody(rawBody, 'the-wrong-secret');
    expect(verifyGithubSignature(request(rawBody, sig), SECRET)).toBe(false);
  });

  it('rejects a missing signature header', () => {
    expect(verifyGithubSignature(request(rawBody), SECRET)).toBe(false);
  });

  it('rejects when no rawBody was captured (nothing to verify against)', () => {
    const sig = signGithubBody(rawBody, SECRET);
    expect(verifyGithubSignature({ headers: { 'x-hub-signature-256': sig }, body: {} }, SECRET)).toBe(false);
  });

  it('rejects an empty secret rather than trusting everything', () => {
    const sig = signGithubBody(rawBody, '');
    expect(verifyGithubSignature(request(rawBody, sig), '')).toBe(false);
  });

  it('does not throw on a garbage signature of a different length (timing-safe guard)', () => {
    expect(verifyGithubSignature(request(rawBody, 'sha256=short'), SECRET)).toBe(false);
  });
});
