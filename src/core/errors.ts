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
  | 'credential_scope'
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

// These failures never left this machine, but only when the call that failed was the connect or the lookup itself.
const CONNECT_STAGE = new Set([
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);
const CONNECT_SYSCALLS = new Set(['connect', 'getaddrinfo']);
// undici raises these before it dispatches anything.
const NOT_DISPATCHED = new Set(['UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_CLOSED', 'UND_ERR_DESTROYED']);
// The connection broke once the request may have gone out.
const IN_FLIGHT = new Set([
  'ECONNRESET',
  'EPIPE',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
]);
// Raised on this machine while building the request: the step's input is at fault, and sending again cannot help.
const INVALID_REQUEST = new Set([
  'UND_ERR_INVALID_ARG',
  'UND_ERR_NOT_SUPPORTED',
  'UND_ERR_REQ_CONTENT_LENGTH_MISMATCH',
]);
const LOCAL_ARGUMENT = /^ERR_INVALID_ARG_/;
const TLS_HANDSHAKE = /^ERR_(TLS|SSL)_|CERT|SIGNATURE/;
const CERTIFICATE = /CERT|SIGNATURE/;
const BODY_DECODE = /^Z_|^ERR__|^ERR_BROTLI|^ERR_ZLIB|^ZSTD_error_/;

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
  return message || codeOf(err) || (name && name !== 'Error' ? name : '') || 'no reason given';
}

function neverSent(err: unknown): boolean {
  const inner = nested(err);
  if (inner.length > 0) return inner.every(neverSent);
  const syscall = (err as { syscall?: unknown } | null)?.syscall;
  if (typeof syscall === 'string') return CONNECT_SYSCALLS.has(syscall);
  const code = codeOf(err);
  return NOT_DISPATCHED.has(code) || TLS_HANDSHAKE.test(code) || CONNECT_STAGE.has(code);
}

function failure(
  code: ActionErrorCode,
  message: string,
  retryable: boolean,
  cause: Error,
  detail: { origin: string; reason: string },
): ActionError {
  return new ActionError({ code, message, retryable, cause, detail });
}

/** True for a certificate that failed verification, as opposed to any other TLS failure. */
export function isCertificateFailure(err: unknown): boolean {
  return CERTIFICATE.test(codeOf(err));
}

/** True for a failure in the TLS handshake, before any request bytes were written. */
export function isTlsFailure(err: unknown): boolean {
  return TLS_HANDSHAKE.test(codeOf(err));
}

/** A failure before anything was written to `origin`: never sent, so retried, unless a certificate was refused. */
export function neverReached(origin: string, cause: Error): ActionError {
  const reason = failureReason(cause);
  return failure(
    'transport_unreachable',
    `could not reach ${origin}: ${reason}`,
    !CERTIFICATE.test(codeOf(cause)),
    cause,
    {
      origin,
      reason,
    },
  );
}

/** Classify a broken network hop by where it broke: a request that could not be built, a host never reached, a reply that was not HTTP, or a connection lost once the request may have gone out. */
export function transportFailure(origin: string, cause: Error, stage: 'request' | 'response'): ActionError {
  const reason = failureReason(cause);
  const detail = { origin, reason };
  const code = codeOf(cause);
  if (BODY_DECODE.test(code)) {
    return failure(
      'provider_error',
      `${origin} sent a response body that could not be decoded: ${reason}`,
      false,
      cause,
      detail,
    );
  }
  if (stage === 'request' && (INVALID_REQUEST.has(code) || LOCAL_ARGUMENT.test(code))) {
    return failure(
      'invalid_input',
      `the request to ${origin} could not be sent: ${reason}`,
      false,
      cause,
      detail,
    );
  }
  if (cause.name === 'HTTPParserError' || code.startsWith('HPE_')) {
    return failure('http_error', `${origin} did not answer with HTTP: ${reason}`, false, cause, detail);
  }
  if (stage === 'request' && neverSent(cause)) return neverReached(origin, cause);
  const when = stage === 'response' ? 'while reading the response' : 'possibly after the request was sent';
  return failure(
    'transport_interrupted',
    `the connection to ${origin} broke ${when}: ${reason}`,
    true,
    cause,
    detail,
  );
}

/** Normalise ANY thrown value to {@link NormalizedFailure}; unrecognised throws are non-retryable so a bug never spins a retry loop. */
export function normalizeError(err: unknown): NormalizedFailure {
  if (err instanceof ActionError) return err.toFailure();

  if (err instanceof Error) {
    const code = codeOf(err);
    if (err.name === 'AbortError' || code === 'ABORT_ERR') {
      return { status: 0, message: redactSecrets(err.message || 'request aborted'), retryable: true };
    }
    if (CONNECT_STAGE.has(code) || NOT_DISPATCHED.has(code) || IN_FLIGHT.has(code)) {
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

const REDACTED = '[redacted]';

/** `text` with a transport's own `redact` applied, then {@link redactSecrets}; text `redact` throws on is redacted whole. */
export function scrubText(text: string, redact?: (text: string) => string): string {
  try {
    return redactSecrets(redact ? redact(text) : text);
  } catch {
    return REDACTED;
  }
}

/** A copy of `err` safe to log: its message, stack, detail and every cause it wraps, scrubbed by {@link scrubText}. */
export function scrubError(err: unknown, redact?: (text: string) => string): unknown {
  const clean = (text: string): string => scrubText(text, redact);
  try {
    return new Scrubber(clean).value(err);
  } catch {
    return withheld(err, clean);
  }
}

/** A raw failure cut to its name, message, stack, `code`, `errno`, `syscall` and the same of its cause, then scrubbed: what diagnoses it, never the request it carried. */
export function redactedError(err: unknown): Error {
  try {
    return scrubError(diagnostic(err, new Set())) as Error;
  } catch {
    return new Error(REDACTED);
  }
}

const DIAGNOSTIC_FIELDS = ['code', 'errno', 'syscall'];

function diagnostic(err: unknown, seen: Set<Error>): Error {
  if (!(err instanceof Error)) return new Error(String(err));
  seen.add(err);
  const text = (key: string): string | undefined => {
    const value = read(err, key);
    return typeof value === 'string' ? value : undefined;
  };
  const copy = new Error(text('message') ?? '');
  copy.name = text('name') ?? copy.name;
  copy.stack = text('stack') ?? header(copy.name, copy.message);
  for (const key of DIAGNOSTIC_FIELDS) {
    const value = read(err, key);
    if (typeof value === 'string' || typeof value === 'number') Object.assign(copy, { [key]: value });
  }
  const cause = read(err, 'cause');
  if (cause instanceof Error && !seen.has(cause)) copy.cause = diagnostic(cause, seen);
  return copy;
}

// Fails closed: what the scrubber cannot walk leaves as its scrubbed message and an ActionError's machine fields.
function withheld(err: unknown, clean: (text: string) => string): ActionError {
  try {
    const shape =
      err instanceof ActionError
        ? { code: err.code, status: err.status, retryable: err.retryable }
        : { code: 'unknown' as const, retryable: false };
    return new ActionError({ ...shape, message: scrubbedMessage(err, clean) });
  } catch {
    return new ActionError({ code: 'unknown', message: REDACTED, retryable: false });
  }
}

function scrubbedMessage(err: unknown, clean: (text: string) => string): string {
  try {
    return clean(String(err instanceof Error ? err.message : err));
  } catch {
    return REDACTED;
  }
}

const UNREADABLE = Symbol('unreadable');
const ERROR_FIELDS = new Set(['name', 'message', 'stack', 'cause', 'errors']);
const ACTION_ERROR_FIELDS = new Set([...ERROR_FIELDS, 'code', 'status', 'retryable']);

function read(from: object, key: string): unknown {
  try {
    return (from as Record<string, unknown>)[key];
  } catch {
    return UNREADABLE;
  }
}

function header(name: string, message: string): string {
  return message ? `${name}: ${message}` : name;
}

// Keeps strings (scrubbed), primitives, arrays, plain objects and errors; drops anything else, and any entry it cannot read.
class Scrubber {
  private readonly copies = new Map<object, object>();

  constructor(private readonly clean: (text: string) => string) {}

  value(value: unknown): unknown {
    if (typeof value === 'string') return this.clean(value);
    if (typeof value === 'function' || typeof value === 'symbol') return undefined;
    if (typeof value !== 'object' || value === null) return value;
    const copied = this.copies.get(value);
    if (copied) return copied;
    if (value instanceof Error) return this.error(value);
    if (Array.isArray(value)) return this.fill(value, [] as unknown[]);
    const proto: unknown = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null ? this.fill(value, {}) : undefined;
  }

  private fill<T extends object>(from: object, into: T, skip?: ReadonlySet<string>): T {
    this.copies.set(from, into);
    for (const key of Object.keys(from)) {
      if (skip?.has(key)) continue;
      const entry = read(from, key);
      if (entry === UNREADABLE) continue;
      Object.defineProperty(into, this.clean(key), {
        value: this.value(entry),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return into;
  }

  private error(err: Error): Error {
    const copy =
      err instanceof ActionError
        ? new ActionError({ code: err.code, status: err.status, retryable: err.retryable, message: '' })
        : new Error('');
    this.fill(err, copy, copy instanceof ActionError ? ACTION_ERROR_FIELDS : ERROR_FIELDS);
    const name = String(err.name);
    const message = String(err.message);
    if (name !== copy.name) copy.name = this.clean(name);
    copy.message = this.clean(message);
    if (typeof err.stack === 'string') copy.stack = this.stack(err.stack, name, copy);
    for (const key of ['cause', 'errors'] as const) {
      const value = key in err ? read(err, key) : UNREADABLE;
      if (value === UNREADABLE) continue;
      Object.defineProperty(copy, key, { value: this.value(value), writable: true, configurable: true });
    }
    return copy;
  }

  // All after the name is scrubbed as one: the header may still hold a message since cut through a secret.
  private stack(stack: string, name: string, copy: Error): string {
    return stack.startsWith(name) ? copy.name + this.clean(stack.slice(name.length)) : this.clean(stack);
  }
}
