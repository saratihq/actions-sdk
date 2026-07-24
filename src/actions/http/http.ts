import { defineAction } from '../../core/action';
import { ActionError } from '../../core/errors';
import { guardUserUrl } from '../../core/http/ssrf';
import type { HttpMethod, JsonValue, QueryValue } from '../../core/http/types';
import { checkbox, dropdown, json, shortText } from '../../core/props';

/**
 * HTTP utilities — a no-auth ("none" scheme) native app. `http.send_request` is
 * load-bearing (the IR generator emits it), so its public type is kept
 * byte-identical to the platform's existing catalog id. Because the scheme is
 * `none` the request rides the direct transport with no credential attached —
 * callers bring their own auth via the `headers` prop.
 */

/** Coerce a JSON object into a string→string header map. */
function toHeaderRecord(value: JsonValue | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) {
      if (v !== null && v !== undefined) out[k] = typeof v === 'object' ? JSON.stringify(v) : String(v);
    }
  }
  return out;
}

/** Coerce a JSON object into a query-param map the client understands. */
function toQueryRecord(value: JsonValue | undefined): Record<string, QueryValue> {
  const out: Record<string, QueryValue> = {};
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) {
      if (Array.isArray(v)) {
        out[k] = v.map((item) =>
          typeof item === 'object' && item !== null ? JSON.stringify(item) : item,
        ) as Array<string | number | boolean>;
      } else if (v === null || v === undefined) {
        out[k] = v;
      } else if (typeof v === 'object') {
        out[k] = JSON.stringify(v);
      } else {
        out[k] = v;
      }
    }
  }
  return out;
}

const METHODS_WITHOUT_BODY = new Set<HttpMethod>(['GET', 'HEAD']);

export const SEND_REQUEST_TYPE = 'http.send_request';
export interface SendRequestResult {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}
export const sendRequest = defineAction({
  type: SEND_REQUEST_TYPE,
  name: 'Send HTTP request',
  description: 'Send an HTTP request to any URL and return the status, headers and body.',
  auth: { type: 'none' },
  props: {
    method: dropdown<HttpMethod, false>({
      label: 'Method',
      required: false,
      defaultValue: 'GET',
      options: [
        { label: 'GET', value: 'GET' },
        { label: 'POST', value: 'POST' },
        { label: 'PUT', value: 'PUT' },
        { label: 'PATCH', value: 'PATCH' },
        { label: 'DELETE', value: 'DELETE' },
        { label: 'HEAD', value: 'HEAD' },
      ],
    }),
    url: shortText({ label: 'URL', required: true }),
    headers: json({ label: 'Headers', description: 'A JSON object of request headers.', required: false }),
    queryParams: json({
      label: 'Query parameters',
      description: 'A JSON object of query params.',
      required: false,
    }),
    body: json({ label: 'Body', description: 'A JSON request body.', required: false }),
    failOnError: checkbox({ label: 'Fail on non-2xx response', required: false, defaultValue: true }),
  },
  async run({ auth, props, http }): Promise<SendRequestResult> {
    const method = props.method ?? 'GET';
    // SSRF guard: this URL is fully user-controlled and rides the no-auth direct
    // transport, so a workflow could otherwise reach internal services or cloud
    // metadata. Public destinations pass; operators opt internal hosts back in.
    await guardUserUrl(props.url);
    const res = await http.request(method, props.url, {
      auth,
      headers: toHeaderRecord(props.headers),
      query: toQueryRecord(props.queryParams),
      ...(props.body !== undefined && !METHODS_WITHOUT_BODY.has(method) ? { body: props.body } : {}),
      throwOnError: props.failOnError ?? true,
    });
    return { status: res.status, headers: res.headers, body: res.data };
  },
});

export const PARSE_URL_TYPE = 'http.parse_url';
export interface ParseUrlResult {
  protocol: string;
  host: string;
  hostname: string;
  port: string;
  pathname: string;
  search: string;
  hash: string;
  origin: string;
  query: Record<string, string>;
}
export const parseUrl = defineAction({
  type: PARSE_URL_TYPE,
  name: 'Parse URL',
  description: 'Break a URL into its components and query parameters.',
  auth: { type: 'none' },
  props: { url: shortText({ label: 'URL', required: true }) },
  run: ({ props }): Promise<ParseUrlResult> => {
    let parsed: URL;
    try {
      parsed = new URL(props.url);
    } catch {
      throw new ActionError({
        code: 'invalid_input',
        message: `invalid URL: "${props.url}"`,
        retryable: false,
      });
    }
    const query: Record<string, string> = {};
    for (const [k, v] of parsed.searchParams) query[k] = v;
    return Promise.resolve({
      protocol: parsed.protocol,
      host: parsed.host,
      hostname: parsed.hostname,
      port: parsed.port,
      pathname: parsed.pathname,
      search: parsed.search,
      hash: parsed.hash,
      origin: parsed.origin,
      query,
    });
  },
});
