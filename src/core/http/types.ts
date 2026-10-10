/** HTTP methods the SDK issues. */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';

/** JSON value — the body/response shape the transports can carry faithfully. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** A single query parameter value; arrays repeat the key. */
export type QueryValue = string | number | boolean | undefined | null | Array<string | number | boolean>;

/** Brand marking a {@link MultipartBody}; a Symbol so plain JSON can never masquerade as one. */
export const MULTIPART = Symbol('orchestr.http.multipart');

/** One part of a multipart/form-data body: a scalar field or a file. */
export type MultipartPart =
  | { readonly type: 'field'; readonly name: string; readonly value: string }
  | {
      readonly type: 'file';
      readonly name: string;
      readonly filename: string;
      readonly data: Buffer;
      readonly contentType?: string;
    };

/** A multipart/form-data body, distinct from {@link JsonValue}; built by the client, never by action code. */
export interface MultipartBody {
  readonly [MULTIPART]: true;
  readonly parts: readonly MultipartPart[];
}

/** Brand marking a {@link FormBody}; a Symbol so plain JSON can never masquerade as one. */
export const FORM = Symbol('orchestr.http.form');

/** A url-encoded body of already-flattened `[key, value]` pairs (arrays expanded to `key[i]`). */
export interface FormBody {
  readonly [FORM]: true;
  readonly fields: readonly (readonly [string, string])[];
}

/** What an action may send as a request body: JSON (default), multipart (files), or form (url-encoded). */
export type RequestBody = JsonValue | MultipartBody | FormBody;

/** How the caller wants the response body decoded: parsed JSON (default) or raw bytes. */
export type ResponseType = 'json' | 'binary';

/** Narrow a body to a {@link MultipartBody} — forgery-proof via the symbol brand. */
export function isMultipartBody(body: RequestBody | undefined): body is MultipartBody {
  return typeof body === 'object' && body !== null && (body as MultipartBody)[MULTIPART] === true;
}

/** Narrow a body to a {@link FormBody} — forgery-proof via the symbol brand. */
export function isFormBody(body: RequestBody | undefined): body is FormBody {
  return typeof body === 'object' && body !== null && (body as FormBody)[FORM] === true;
}

/** A normalised outbound request; `url` is absolute with `query` already merged in by the client. */
export interface NormalizedRequest {
  method: HttpMethod;
  url: string;
  /** Header names are treated case-insensitively by transports. */
  headers: Record<string, string>;
  body?: RequestBody;
  /** `'binary'` → the transport returns the raw response bytes as a `Buffer` in `data`. */
  responseType?: ResponseType;
  /** Abort signal for cancellation/timeouts; transports must honour it. */
  signal?: AbortSignal;
}

/** A normalised response; `data` is parsed JSON, raw text, or a Buffer for `responseType: 'binary'`. */
export interface NormalizedResponse {
  status: number;
  /** Lower-cased header names. */
  headers: Record<string, string>;
  data: unknown;
}

/** The transport seam: owns credential attachment and the network hop — never retries or pagination, and returns non-2xx rather than throwing. */
export interface Transport {
  /** A stable label for diagnostics ("direct", "managed-proxy"). Never secret. */
  readonly kind: string;
  send(request: NormalizedRequest): Promise<NormalizedResponse>;
}

/** The subset of the WHATWG `fetch` signature the SDK depends on; injectable so a host can supply its own. */
export type FetchLike = (
  input: string | URL,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    /** String for JSON/text; raw bytes for a multipart body. */
    body?: string | Buffer | Uint8Array;
    signal?: AbortSignal;
    /** `'manual'` hands back a redirect response unfollowed; the default follows it. */
    redirect?: 'follow' | 'manual';
  },
) => Promise<FetchLikeResponse>;

export interface FetchLikeResponse {
  status: number;
  headers: { forEach(cb: (value: string, key: string) => void): void };
  text(): Promise<string>;
  /** Raw response bytes — used when the request asked for `responseType: 'binary'`. */
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** Resolve the runtime fetch, or throw a clear error if the host has none. */
export function resolveFetch(candidate?: FetchLike): FetchLike {
  if (candidate) return candidate;
  const globalFetch = (globalThis as { fetch?: unknown }).fetch;
  if (typeof globalFetch === 'function') return globalFetch as FetchLike;
  throw new Error('No fetch implementation available — pass one explicitly (Node >= 18 has a global fetch)');
}

/** Lower-case every header key; drop null/undefined values. */
export function normalizeHeaders(headers?: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || value === null) continue;
    out[name.toLowerCase()] = value;
  }
  return out;
}

/** Append query params to a URL, preserving existing ones; arrays repeat the key, null/undefined are dropped. */
export function appendQuery(url: string, query?: Record<string, QueryValue>): string {
  if (!query) return url;
  const pairs = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const v of value) pairs.append(key, String(v));
    } else {
      pairs.append(key, String(value));
    }
  }
  const search = pairs.toString();
  if (!search) return url;
  return url + (url.includes('?') ? '&' : '?') + search;
}
