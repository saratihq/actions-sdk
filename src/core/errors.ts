/** The ONE failure shape: every failure, from any layer, normalises to `{ status, message, retryable }`. */
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
  | 'unresolvable_host'
  | 'auth_missing'
  | 'auth_unsupported'
  | 'transport_unreachable'
  | 'transport_interrupted'
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

/** The single error type the SDK throws; reduces to the wire contract via {@link ActionError.toFailure}. */
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

/** Retry policy by status: transport failures and transient statuses retry, ordinary 4xx and 501/505 do not. */
export function isRetryableStatus(status: number): boolean {
  if (status === 0) return true; // no response — network/timeout/abort
  if (status === 408 || status === 425 || status === 429) return true; // timeout / too-early / rate-limited
  if (status === 501 || status === 505) return false; // not-implemented / version-not-supported
  return status >= 500 && status <= 599;
}

// The request never left this machine: safe to send again whatever the method.
const CONNECT_STAGE = new Set([
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
]);
// The connection broke once the request may have gone out.
const IN_FLIGHT = new Set([
  'ECONNRESET',
  'EPIPE',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
]);
const INVALID_REQUEST = new Set(['UND_ERR_INVALID_ARG', 'UND_ERR_NOT_SUPPORTED']);
const TLS_HANDSHAKE = /^ERR_(TLS|SSL)_|CERT|SIGNATURE/;

function codeOf(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : '';
}

function nested(err: unknown): unknown[] {
  const errors = (err as { errors?: unknown } | null)?.errors;
  return Array.isArray(errors) ? errors : [];
}

/** A failure's reason in words, reading an AggregateError's inner errors (a host whose every address failed). */
export function failureReason(err: unknown): string {
  const inner = nested(err);
  if (inner.length > 0) return [...new Set(inner.map(failureReason))].join('; ');
  const { message, name } = err as { message?: string; name?: string };
  return message || codeOf(err) || name || 'unknown error';
}

function neverSent(err: unknown): boolean {
  const inner = nested(err);
  if (inner.length > 0) return inner.every(neverSent);
  const code = codeOf(err);
  return CONNECT_STAGE.has(code) || TLS_HANDSHAKE.test(code);
}

/** Classify a broken network hop by where it broke: a request that could not be built, a host never reached, or a connection lost once the request may have gone out. */
export function transportFailure(origin: string, cause: Error, stage: 'request' | 'response'): ActionError {
  const reason = failureReason(cause);
  const detail = { origin, reason };
  if (stage === 'request' && INVALID_REQUEST.has(codeOf(cause))) {
    return new ActionError({
      code: 'invalid_input',
      message: `the request to ${origin} could not be sent: ${reason}`,
      retryable: false,
      cause,
      detail,
    });
  }
  if (stage === 'request' && neverSent(cause)) {
    return new ActionError({
      code: 'transport_unreachable',
      message: `could not reach ${origin}: ${reason}`,
      retryable: true,
      cause,
      detail,
    });
  }
  const when = stage === 'response' ? 'while reading the response' : 'possibly after the request was sent';
  return new ActionError({
    code: 'transport_interrupted',
    message: `the connection to ${origin} broke ${when}: ${reason}`,
    retryable: true,
    cause,
    detail,
  });
}

/** Normalise ANY thrown value to {@link NormalizedFailure}; unrecognised throws are non-retryable so a bug never spins a retry loop. */
export function normalizeError(err: unknown): NormalizedFailure {
  if (err instanceof ActionError) return err.toFailure();

  if (err instanceof Error) {
    const code = codeOf(err);
    if (err.name === 'AbortError' || code === 'ABORT_ERR') {
      return { status: 0, message: redactSecrets(err.message || 'request aborted'), retryable: true };
    }
    if (CONNECT_STAGE.has(code) || IN_FLIGHT.has(code)) {
      return { status: 0, message: redactSecrets(err.message || code), retryable: true };
    }
    return { status: 0, message: redactSecrets(err.message || 'unexpected error'), retryable: false };
  }

  return { status: 0, message: 'unexpected non-error thrown', retryable: false };
}

/** Scrub credential-shaped substrings from a message before it is logged; best-effort, never throws. */
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
