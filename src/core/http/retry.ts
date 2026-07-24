/**
 * Retry policy and backoff maths. The client's request loop owns *when* to retry
 * (only retryable failures, only idempotent-by-default reads unless the caller
 * opts in); these helpers own *how long* to wait. Kept pure and separate so the
 * timing logic is unit-testable without a network.
 */

export interface RetryPolicy {
  /** Max additional attempts after the first (so 3 = up to 4 total sends). */
  retries: number;
  /** Base delay for exponential backoff. */
  baseDelayMs: number;
  /** Ceiling on any single backoff wait. */
  maxDelayMs: number;
  /** Add ±50% jitter to spread retries and avoid thundering herds. */
  jitter: boolean;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  retries: 3,
  baseDelayMs: 300,
  maxDelayMs: 10_000,
  jitter: true,
};

/** Exponential backoff for a zero-based attempt index, capped and optionally jittered. */
export function backoffDelay(attempt: number, policy: RetryPolicy): number {
  const raw = policy.baseDelayMs * 2 ** attempt;
  const capped = Math.min(raw, policy.maxDelayMs);
  if (!policy.jitter) return capped;
  // Full jitter in [capped/2, capped] — keeps a floor so we don't hot-loop.
  const half = capped / 2;
  return Math.round(half + Math.random() * half);
}

/**
 * Parse a `Retry-After` header into milliseconds. Supports both forms in the
 * spec: delta-seconds (`120`) and an HTTP date. Returns null when absent or
 * unparseable so the caller falls back to backoff.
 */
export function parseRetryAfter(value: string | undefined): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) {
    const delta = dateMs - Date.now();
    return delta > 0 ? delta : 0;
  }
  return null;
}

/** Promise-based sleep that rejects promptly if the abort signal fires. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = (): void => {
      cleanup();
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
