import { type AuthHandle, transportOf } from '../auth';
import { ActionError, isRetryableStatus, type NormalizedFailure } from '../errors';
import { buildForm, type FormInput } from './form';
import { buildMultipart, type MultipartInput } from './multipart';
import { backoffDelay, DEFAULT_RETRY_POLICY, parseRetryAfter, type RetryPolicy, sleep } from './retry';
import {
  appendQuery,
  type HttpMethod,
  type JsonValue,
  normalizeHeaders,
  type NormalizedRequest,
  type QueryValue,
  type RequestBody,
  type ResponseType,
} from './types';

const DEFAULT_TIMEOUT_MS = 30_000;
/** Methods safe to retry after an ambiguous failure without risking a duplicate side effect. */
const IDEMPOTENT_METHODS = new Set<HttpMethod>(['GET', 'HEAD', 'PUT', 'DELETE']);

/** Per-call options. `auth` is required — it carries the transport the request rides. */
export interface RequestOptions {
  auth: AuthHandle;
  headers?: Record<string, string>;
  query?: Record<string, QueryValue>;
  body?: JsonValue;
  /**
   * A multipart/form-data body (file upload). Mutually exclusive with `body`.
   * Rides only the direct transport — the managed proxy rejects it loudly (JSON only).
   */
  multipart?: MultipartInput;
  /**
   * An `application/x-www-form-urlencoded` body — for providers whose writes take
   * form bodies, not JSON (Stripe's REST API). Mutually exclusive with `body`/
   * `multipart`. Rides only the direct transport — the managed proxy rejects it (JSON only).
   */
  form?: FormInput;
  /**
   * `'binary'` returns the raw response bytes as a `Buffer` in `data` (for
   * downloading a file). Defaults to `'json'` (parse JSON, else raw text).
   */
  responseType?: ResponseType;
  /** Caller cancellation; composed with the per-request timeout. */
  signal?: AbortSignal;
  /** Override the client's default timeout for this call. */
  timeoutMs?: number;
  /**
   * Force retry-on-failure for a normally non-idempotent method (e.g. a POST
   * carrying an idempotency key). Defaults to the method's natural idempotency.
   */
  idempotent?: boolean;
  /** Return the response even on non-2xx instead of throwing. Default: throw. */
  throwOnError?: boolean;
}

export interface HttpResponse<T = unknown> {
  status: number;
  /** Lower-cased header names. */
  headers: Record<string, string>;
  data: T;
}

export interface HttpClientOptions {
  retry?: Partial<RetryPolicy>;
  defaultTimeoutMs?: number;
  /** Headers added to every request unless overridden per-call. */
  defaultHeaders?: Record<string, string>;
}

/**
 * The transport-agnostic HTTP client actions call. It owns everything that must
 * behave identically regardless of *how* the request is sent: URL/query
 * assembly, default headers, per-request timeouts, retry-with-backoff on
 * retryable failures (respecting `Retry-After`), and reducing every non-2xx or
 * transport error to the one {@link NormalizedFailure} shape. The credential and
 * the wire hop belong to the {@link Transport} pulled from `auth`.
 */
export class HttpClient {
  private readonly retry: RetryPolicy;
  private readonly defaultTimeoutMs: number;
  private readonly defaultHeaders: Record<string, string>;

  constructor(options: HttpClientOptions = {}) {
    this.retry = { ...DEFAULT_RETRY_POLICY, ...options.retry };
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.defaultHeaders = { accept: 'application/json', ...normalizeHeaders(options.defaultHeaders) };
  }

  get<T = unknown>(url: string, options: RequestOptions): Promise<HttpResponse<T>> {
    return this.request<T>('GET', url, options);
  }

  post<T = unknown>(url: string, options: RequestOptions): Promise<HttpResponse<T>> {
    return this.request<T>('POST', url, options);
  }

  put<T = unknown>(url: string, options: RequestOptions): Promise<HttpResponse<T>> {
    return this.request<T>('PUT', url, options);
  }

  patch<T = unknown>(url: string, options: RequestOptions): Promise<HttpResponse<T>> {
    return this.request<T>('PATCH', url, options);
  }

  delete<T = unknown>(url: string, options: RequestOptions): Promise<HttpResponse<T>> {
    return this.request<T>('DELETE', url, options);
  }

  /** The one send path: builds the request, runs the retry loop, normalises failures. */
  async request<T = unknown>(
    method: HttpMethod,
    url: string,
    options: RequestOptions,
  ): Promise<HttpResponse<T>> {
    const transport = transportOf(options.auth);
    const headers = { ...this.defaultHeaders, ...normalizeHeaders(options.headers) };
    const bodyKinds = [options.body, options.multipart, options.form].filter((b) => b !== undefined).length;
    if (bodyKinds > 1) {
      throw new ActionError({
        code: 'invalid_input',
        message: 'pass exactly one of `body` (JSON), `multipart` (files), or `form` (url-encoded)',
        retryable: false,
      });
    }
    // The multipart/form bodies carry their own Content-Type (boundary /
    // url-encoded), set by the transport when it encodes; only a JSON `body` gets
    // the default json header.
    const body: RequestBody | undefined =
      options.multipart !== undefined
        ? buildMultipart(options.multipart)
        : options.form !== undefined
          ? buildForm(options.form)
          : options.body;
    if (options.body !== undefined && !('content-type' in headers)) {
      headers['content-type'] = 'application/json';
    }
    const finalUrl = appendQuery(url, options.query);
    const idempotent = options.idempotent ?? IDEMPOTENT_METHODS.has(method);
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;

    let attempt = 0;
    for (;;) {
      // Fresh timeout controller per attempt, composed with the caller's signal.
      const { signal, expired, dispose } = withTimeout(timeoutMs, options.signal);
      const request: NormalizedRequest = {
        method,
        url: finalUrl,
        headers,
        ...(body !== undefined ? { body } : {}),
        ...(options.responseType ? { responseType: options.responseType } : {}),
        signal,
      };

      let failure: NormalizedFailure | null = null;
      let retryAfterMs: number | null = null;
      // The transport's own ActionError, kept so a definitive failure (e.g.
      // `unsupported_body` — a file on the JSON-only proxy) surfaces with its
      // real code, not relabelled `transport_unreachable` when we stop retrying.
      let thrown: ActionError | null = null;
      try {
        // Race the send against the timeout so a transport that ignores the
        // abort signal can never hang the client past `timeoutMs`.
        const response = await Promise.race([transport.send(request), expired]);
        if (response.status >= 200 && response.status < 300) {
          dispose();
          return { status: response.status, headers: response.headers, data: response.data as T };
        }
        // A non-2xx HTTP response — surface (or throw) unless retryable.
        if (options.throwOnError === false) {
          dispose();
          return { status: response.status, headers: response.headers, data: response.data as T };
        }
        failure = httpFailure(response.status, response.data);
        retryAfterMs = parseRetryAfter(response.headers['retry-after']);
      } catch (err) {
        // Transport-level throw (unreachable/timeout/aborted) already normalised.
        if (err instanceof ActionError) thrown = err;
        failure =
          err instanceof ActionError ? err.toFailure() : { status: 0, message: String(err), retryable: true };
      } finally {
        dispose();
      }

      // If the caller aborted, don't keep retrying — propagate immediately.
      if (options.signal?.aborted) {
        throw new ActionError({
          code: 'transport_timeout',
          message: 'request aborted by caller',
          status: 0,
          retryable: false,
        });
      }

      const canRetry =
        failure.retryable && (idempotent || failure.status === 0) && attempt < this.retry.retries;
      if (!canRetry) {
        // Preserve the transport's own error (real code + detail) when it threw
        // one; only synthesise for the HTTP-status path (no original error).
        if (thrown) throw thrown;
        throw new ActionError({
          code: failure.status === 0 ? 'transport_unreachable' : 'http_error',
          message: failure.message,
          status: failure.status,
          retryable: failure.retryable,
          detail: failure.status === 0 ? undefined : safeDetail(failure),
        });
      }

      const wait = retryAfterMs ?? backoffDelay(attempt, this.retry);
      await sleep(Math.min(wait, this.retry.maxDelayMs), options.signal);
      attempt += 1;
    }
  }
}

/**
 * A per-attempt timeout: an {@link AbortSignal} that fires on timeout or when the
 * caller aborts, plus an `expired` promise that REJECTS on timeout so the client
 * can race it against the send. `expired` never resolves; it is only ever raced.
 */
function withTimeout(
  timeoutMs: number,
  caller?: AbortSignal,
): { signal: AbortSignal; expired: Promise<never>; dispose: () => void } {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(new DOMException('Timeout', 'TimeoutError'));
      reject(
        new ActionError({
          code: 'transport_timeout',
          message: `request timed out after ${timeoutMs}ms`,
          status: 0,
          retryable: true,
        }),
      );
    }, timeoutMs);
  });
  // Swallow the rejection if it is never raced (attempt succeeded first).
  void expired.catch(() => undefined);
  const onCallerAbort = (): void => controller.abort();
  if (caller) {
    if (caller.aborted) controller.abort();
    else caller.addEventListener('abort', onCallerAbort, { once: true });
  }
  const dispose = (): void => {
    if (timer) clearTimeout(timer);
    caller?.removeEventListener('abort', onCallerAbort);
  };
  return { signal: controller.signal, expired, dispose };
}

/** Build a NormalizedFailure from a non-2xx HTTP response, extracting a useful message. */
function httpFailure(status: number, data: unknown): NormalizedFailure {
  return { status, message: `HTTP ${status}${extractMessage(data)}`, retryable: isRetryableStatus(status) };
}

/** Pull a short, non-secret message out of a provider error body when present. */
function extractMessage(data: unknown): string {
  if (typeof data === 'string' && data.length > 0) return `: ${data.slice(0, 200)}`;
  if (data && typeof data === 'object') {
    const record = data as Record<string, unknown>;
    const candidate = record.message ?? record.error ?? record.error_description ?? record.detail;
    if (typeof candidate === 'string' && candidate.length > 0) return `: ${candidate.slice(0, 200)}`;
  }
  return '';
}

/** Keep only a provider error code/message in `detail`; never the whole body (may hold data). */
function safeDetail(failure: NormalizedFailure): { status: number } {
  return { status: failure.status };
}
