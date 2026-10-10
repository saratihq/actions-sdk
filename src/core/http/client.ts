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
  /** multipart/form-data body; exclusive with `body`/`form`, direct transport only (the proxy is JSON-only). */
  multipart?: MultipartInput;
  /** url-encoded form body; exclusive with `body`/`multipart`, direct transport only (the proxy is JSON-only). */
  form?: FormInput;
  /** `'binary'` returns raw bytes as a Buffer in `data`; defaults to `'json'` (JSON, else raw text). */
  responseType?: ResponseType;
  /** Caller cancellation; composed with the per-request timeout. */
  signal?: AbortSignal;
  /** Override the client's default timeout for this call. */
  timeoutMs?: number;
  /** Force (or forbid) retry for a method whose natural idempotency says otherwise. */
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

/** Transport-agnostic HTTP client: query/headers, timeouts, retry-with-backoff, and one {@link NormalizedFailure} shape. */
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
    // multipart/form bodies get their Content-Type from the transport; only a JSON `body` is defaulted here.
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
      // Kept so a definitive transport failure keeps its real code instead of `transport_unreachable`.
      let thrown: ActionError | null = null;
      try {
        // Raced so a transport that ignores the abort signal can never hang past `timeoutMs`.
        const response = await Promise.race([transport.send(request), expired]);
        if (response.status >= 200 && response.status < 300) {
          dispose();
          return { status: response.status, headers: response.headers, data: response.data as T };
        }
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

      if (options.signal?.aborted) {
        throw new ActionError({
          code: 'transport_timeout',
          message: 'request aborted by caller',
          status: 0,
          retryable: false,
        });
      }

      // A connection lost once the request may have gone out is resent only when resending is safe.
      const neverSent = failure.status === 0 && thrown?.code !== 'transport_interrupted';
      const canRetry = failure.retryable && (idempotent || neverSent) && attempt < this.retry.retries;
      if (!canRetry) {
        // Only synthesise an error for the HTTP-status path; a transport throw keeps its own code.
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

/** Per-attempt timeout: a signal that fires on timeout/caller-abort, plus an `expired` promise that only ever rejects. */
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
