/**
 * The ONE failure shape.
 *
 * Every failure an action can surface — a transport that never connected, a
 * 429, a 500, a provider envelope that says `ok: false`, invalid input — is
 * normalised to this single object. Callers (the runtime, the client
 * inspector, a retry loop) branch on `retryable` and show `message`; they never
 * have to know which layer failed. The contract: every failure normalises to one
 * shape `{ status, message, retryable }`.
 */
export interface NormalizedFailure {
  /** HTTP-ish status. `0` means the request never got a response (network/timeout/abort). */
  status: number;
  /** Human-readable, secret-scrubbed. Safe to log and to show a user. */
  message: string;
  /** Whether retrying the same request could plausibly succeed. */
  retryable: boolean;
}

/** Stable machine codes so callers can branch without string-matching messages. */
export type ActionErrorCode =
  | 'invalid_input'
  | 'ssrf_blocked'
  | 'auth_missing'
  | 'auth_unsupported'
  | 'transport_unreachable'
  | 'transport_timeout'
  | 'http_error'
  | 'provider_error'
  | 'unsupported_body'
  | 'pagination_limit'
  | 'unknown';

interface ActionErrorArgs {
  message: string;
  code?: ActionErrorCode;
  /** HTTP-ish status; defaults to 0 (no response). */
  status?: number;
  /** Overrides the status-derived default when the layer knows better. */
  retryable?: boolean;
  /** Safe, non-secret extra context (a provider error code, the failing field). */
  detail?: unknown;
  cause?: unknown;
}

/**
 * The single error type the SDK throws across every boundary. It carries enough
 * for a caller to decide what to do (`code`, `status`, `retryable`) and reduces
 * to the wire contract via {@link ActionError.toFailure}.
 */
export class ActionError extends Error {
  readonly code: ActionErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  readonly detail?: unknown;

  constructor(args: ActionErrorArgs) {
    super(redactSecrets(args.message), args.cause !== undefined ? { cause: args.cause } : undefined);
    this.name = 'ActionError';
    this.code = args.code ?? 'unknown';
    this.status = args.status ?? 0;
    this.retryable = args.retryable ?? isRetryableStatus(this.status);
    if (args.detail !== undefined) this.detail = args.detail;
  }

  toFailure(): NormalizedFailure {
    return { status: this.status, message: this.message, retryable: this.retryable };
  }
}

/**
 * Retry policy by status. Transport failures (status 0) and the transient HTTP
 * statuses are retryable; ordinary 4xx (the caller's request is wrong) are not.
 * 501/505 are "the server will never do this" — not worth a retry.
 */
export function isRetryableStatus(status: number): boolean {
  if (status === 0) return true; // no response — network/timeout/abort
  if (status === 408 || status === 425 || status === 429) return true; // timeout / too-early / rate-limited
  if (status === 501 || status === 505) return false; // not-implemented / version-not-supported
  return status >= 500 && status <= 599;
}

/**
 * Normalise ANY thrown value to {@link NormalizedFailure}. The catch-all seam:
 * an `ActionError` reduces directly; a Node fetch/undici error maps by its
 * `code`; everything else becomes a non-retryable unknown so a bug never
 * masquerades as a transient blip a retry loop spins on forever.
 */
export function normalizeError(err: unknown): NormalizedFailure {
  if (err instanceof ActionError) return err.toFailure();

  if (err instanceof Error) {
    const rawCode = (err as { code?: unknown }).code;
    const code = typeof rawCode === 'string' ? rawCode : '';
    // fetch/undici/Node network codes → status 0, retryable.
    const NETWORKISH = new Set([
      'ECONNRESET',
      'ECONNREFUSED',
      'ETIMEDOUT',
      'EAI_AGAIN',
      'ENOTFOUND',
      'EPIPE',
      'UND_ERR_CONNECT_TIMEOUT',
      'UND_ERR_HEADERS_TIMEOUT',
      'UND_ERR_BODY_TIMEOUT',
      'UND_ERR_SOCKET',
    ]);
    if (err.name === 'AbortError' || code === 'ABORT_ERR') {
      return { status: 0, message: redactSecrets(err.message || 'request aborted'), retryable: true };
    }
    if (NETWORKISH.has(code)) {
      return { status: 0, message: redactSecrets(err.message || code), retryable: true };
    }
    return { status: 0, message: redactSecrets(err.message || 'unexpected error'), retryable: false };
  }

  return { status: 0, message: 'unexpected non-error thrown', retryable: false };
}

/**
 * Scrub credential-shaped substrings from a message before it is stored or
 * logged. Defence in depth: transports already keep secrets out of errors, but
 * a provider might echo a token in a body, or a URL might carry
 * `?access_token=…`. Best-effort, never throws.
 */
export function redactSecrets(text: string): string {
  if (typeof text !== 'string' || text.length === 0) return text;
  return (
    text
      // `?token=…`, `&access_token=…`, `api_key=…`, `key=…` in query strings
      .replace(
        /([?&](?:access_token|refresh_token|token|api_key|apikey|key|secret)=)[^&\s"']+/gi,
        '$1[redacted]',
      )
      // `Bearer <jwt-or-opaque>` and `xoxb-…` Slack tokens
      .replace(/\b(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[redacted]')
      .replace(/\bxox[baprs]-[A-Za-z0-9-]{8,}/gi, '[redacted]')
  );
}
