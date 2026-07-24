import { backoffDelay, DEFAULT_RETRY_POLICY, parseRetryAfter, sleep } from './retry';

describe('backoffDelay', () => {
  it('grows exponentially and respects the ceiling (no jitter)', () => {
    const policy = { retries: 5, baseDelayMs: 100, maxDelayMs: 1000, jitter: false };
    expect(backoffDelay(0, policy)).toBe(100);
    expect(backoffDelay(1, policy)).toBe(200);
    expect(backoffDelay(2, policy)).toBe(400);
    expect(backoffDelay(10, policy)).toBe(1000); // capped
  });

  it('keeps jittered delays within [capped/2, capped]', () => {
    const policy = { ...DEFAULT_RETRY_POLICY, baseDelayMs: 1000, maxDelayMs: 1000, jitter: true };
    for (let i = 0; i < 50; i += 1) {
      const d = backoffDelay(5, policy);
      expect(d).toBeGreaterThanOrEqual(500);
      expect(d).toBeLessThanOrEqual(1000);
    }
  });
});

describe('parseRetryAfter', () => {
  it('parses delta-seconds', () => {
    expect(parseRetryAfter('120')).toBe(120_000);
  });

  it('parses an HTTP date into a positive delay', () => {
    const future = new Date(Date.now() + 5000).toUTCString();
    const ms = parseRetryAfter(future);
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual(5000);
  });

  it('returns null for missing/garbage', () => {
    expect(parseRetryAfter(undefined)).toBeNull();
    expect(parseRetryAfter('soon')).toBeNull();
  });
});

describe('sleep', () => {
  it('rejects promptly when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(sleep(1000, controller.signal)).rejects.toThrow(/Aborted/);
  });

  it('resolves after the delay', async () => {
    const start = Date.now();
    await sleep(20);
    expect(Date.now() - start).toBeGreaterThanOrEqual(15);
  });
});
