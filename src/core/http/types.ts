/**
 * Wire-level shapes shared by the HTTP client and every transport. Kept
 * deliberately small and JSON-centric: an action describes *what* it wants
 * (method, url, headers, query, body); a {@link Transport} decides *how* the
 * credential is attached and where the bytes go (direct to the provider, or via
 * a managed proxy). The action never sees the difference.
 */

/** HTTP methods the SDK issues. */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';

/** JSON value — the body/response shape the transports can carry faithfully. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** A single query parameter value; arrays repeat the key. */
export type QueryValue = string | number | boolean | undefined | null | Array<string | number | boolean>;

/**
 * Brand that marks a {@link MultipartBody}. A `Symbol` (not a string field) so a
 * plain JSON object can never masquerade as one — the transport's "encode as
 * multipart vs. serialise as JSON" decision must be forgery-proof.
 */
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

/**
 * A multipart/form-data request body — the file-upload shape. Deliberately
 * DISTINCT from {@link JsonValue}: a transport branches on it to encode raw bytes
 * over the wire (direct transport) or reject it loudly (the managed proxy carries JSON
 * only). Built by the client from the `multipart` request option; action code
 * never constructs it by hand.
 */
export interface MultipartBody {
  readonly [MULTIPART]: true;
  readonly parts: readonly MultipartPart[];
}

/**
 * Brand that marks a {@link FormBody}. A `Symbol` (like {@link MULTIPART}) so a
 * plain JSON object can never masquerade as one — the transport's "encode as
 * url-encoded form vs. serialise as JSON" decision must be forgery-proof.
 */
export const FORM = Symbol('orchestr.http.form');

/**
 * An `application/x-www-form-urlencoded` request body. Like {@link MultipartBody}
 * it is DISTINCT from {@link JsonValue}: the direct transport encodes it to a
 * `key=value&…` string; the managed proxy rejects it (JSON only). Carries the
 * already-flattened `[key, value]` pairs (arrays expanded to `key[i]`) built by
 * the `form` request option — action code never constructs it by hand.
 */
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

/**
 * A normalised outbound request. `url` is absolute; `query` is merged into it by
 * the client before the transport sees it. `body` is JSON by default; a
 * {@link MultipartBody} carries file uploads and rides ONLY the direct transport (the
 * managed proxy decodes bodies to JSON and rejects it loudly). `responseType:
 * 'binary'` tells the transport to return raw bytes (a `Buffer`) instead of
 * parsing — for downloading attachments.
 */
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

/**
 * A normalised response. `data` is parsed JSON when the body was JSON, the raw
 * text for other text bodies, or a `Buffer` when the request asked for
 * `responseType: 'binary'`.
 */
export interface NormalizedResponse {
  status: number;
  /** Lower-cased header names. */
  headers: Record<string, string>;
  data: unknown;
}

/**
 * The transport seam. A transport takes a fully-formed request and returns a
 * response, or throws an {@link ActionError}. It owns credential attachment and
 * the network hop; it must NOT implement retries or pagination (those live in
 * the client, transport-agnostically). Non-2xx responses are returned, not
 * thrown — the client decides how to surface them.
 */
export interface Transport {
  /** A stable label for diagnostics ("direct", "managed-proxy"). Never secret. */
  readonly kind: string;
  send(request: NormalizedRequest): Promise<NormalizedResponse>;
}

/**
 * The subset of the WHATWG `fetch` signature the SDK depends on. Injecting it
 * (rather than reaching for the global) makes transports unit-testable without
 * monkey-patching `globalThis` and lets a host supply a proxy-aware fetch.
 */
export type FetchLike = (
  input: string | URL,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    /** String for JSON/text; raw bytes for a multipart body. */
    body?: string | Buffer | Uint8Array;
    signal?: AbortSignal;
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

/**
 * Append query params to a URL, preserving any already present. Arrays repeat
 * the key (`?a=1&a=2`); null/undefined values are dropped. Keeps the SDK's
 * URL-building in one audited place instead of scattered string concatenation.
 */
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
