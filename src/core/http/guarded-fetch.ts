import { isNativeError } from 'node:util/types';

import { fetch, type Response } from 'undici';

import { ActionError, transportFailure } from '../errors';
import { egressDispatcher } from './egress';
import { allowedHosts, preflightTarget, ssrfRefusal, targetHost, withoutUserinfo } from './ssrf';
import type { FetchLike } from './types';

type FetchInit = NonNullable<Parameters<FetchLike>[1]>;

const MAX_REDIRECTS = 20;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const BODY_HEADERS = new Set([
  'content-encoding',
  'content-language',
  'content-location',
  'content-type',
  'content-length',
]);
const CROSS_ORIGIN_DROPPED_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie', 'host']);
// The Fetch standard's blocked ports, as undici lists them: fetch refuses these before connecting and says only "bad port".
const BAD_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104,
  109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515,
  526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049,
  3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const FRAMING_HEADERS = new Set(['content-length']);
// fetch trims leading and trailing whitespace, then refuses a line break, a NUL or a character beyond Latin-1, and its error repeats the value.
function unsendableValue(value: unknown): boolean {
  const text = String(value).replace(/^[\t\n\r ]+|[\t\n\r ]+$/g, '');
  return /[\r\n]/.test(text) || text.includes('\0') || [...text].some((ch) => ch.charCodeAt(0) > 0xff);
}

function withoutHeaders(
  headers: Record<string, string> | undefined,
  names: Set<string>,
): Record<string, string> {
  return Object.fromEntries(Object.entries(headers ?? {}).filter(([name]) => !names.has(name.toLowerCase())));
}

function withoutParams(url: URL, names: readonly string[]): void {
  for (const name of names) if (url.searchParams.has(name)) url.searchParams.delete(name);
}

function unsendable(origin: string, reason: string): ActionError {
  return new ActionError({
    code: 'invalid_input',
    message: `the request to ${origin} could not be sent: ${reason}`,
    retryable: false,
    detail: { origin, reason },
  });
}

function assertSendable(url: URL, { method, headers, body }: FetchInit): void {
  if (url.port && BAD_PORTS.has(Number(url.port))) {
    throw unsendable(
      url.origin,
      `fetch will not connect to port ${url.port}, a port the Fetch standard blocks`,
    );
  }
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (!HEADER_NAME.test(name)) throw unsendable(url.origin, 'a header name is not a valid HTTP token');
    if (unsendableValue(value)) {
      throw unsendable(
        url.origin,
        `header "${name}" has a line break, a NUL or a character outside Latin-1 in its value`,
      );
    }
  }
  if (body !== undefined && /^(GET|HEAD)$/i.test(method ?? 'GET')) {
    throw unsendable(url.origin, `a ${(method ?? 'GET').toUpperCase()} request cannot carry a body`);
  }
}

async function send(url: URL, init: FetchInit): Promise<Response> {
  assertSendable(url, init);
  preflightTarget(url, allowedHosts());
  const { method, body, signal } = init;
  // fetch frames the body itself; a pasted Content-Length that disagrees makes it wait without writing a byte.
  const headers = withoutHeaders(init.headers, FRAMING_HEADERS);
  try {
    return await fetch(url, {
      method,
      headers,
      body,
      signal,
      redirect: 'manual',
      dispatcher: egressDispatcher(),
    });
  } catch (err) {
    if (err instanceof ActionError) throw err;
    const cause = (err as { cause?: unknown }).cause;
    if (cause instanceof ActionError) throw cause;
    if (isNativeError(cause)) throw transportFailure(url.origin, cause, 'request');
    // A TypeError with no cause is fetch refusing its own arguments; only a Headers error can repeat a value.
    if (isNativeError(err) && err.name === 'TypeError') {
      throw unsendable(
        url.origin,
        err.message.startsWith('Headers.') ? 'fetch refused a header' : err.message,
      );
    }
    throw err;
  }
}

function requestUrl(input: string | URL): URL {
  let url: URL;
  try {
    url = new URL(String(input));
  } catch {
    throw new ActionError({
      code: 'invalid_input',
      message: `invalid URL: "${withoutUserinfo(String(input))}"`,
      retryable: false,
    });
  }
  if (url.username || url.password) {
    throw new ActionError({
      code: 'invalid_input',
      message: `refusing a URL with a username or password in it (${url.origin}); send credentials in a header instead`,
      retryable: false,
    });
  }
  return url;
}

function redirectTarget(location: string, from: URL): URL {
  // Servers send raw UTF-8 in Location; fetch reads it back as UTF-8 rather than as Latin-1 bytes.
  const decoded = /[^\x20-\x7e]/.test(location) ? Buffer.from(location, 'latin1').toString('utf8') : location;
  let next: URL;
  try {
    next = new URL(decoded, from);
  } catch {
    throw new ActionError({
      code: 'http_error',
      message: `${from.origin} redirected to an invalid URL`,
      retryable: false,
    });
  }
  if (next.username || next.password) {
    throw new ActionError({
      code: 'http_error',
      message: `${from.origin} redirected to a URL carrying credentials`,
      retryable: false,
    });
  }
  if (next.protocol !== 'http:' && next.protocol !== 'https:') {
    throw new ActionError({
      code: 'http_error',
      message: `${from.origin} redirected to a non-http(s) URL (${next.protocol})`,
      retryable: false,
    });
  }
  return next;
}

// Fetch's own rewrite of a redirected request: 303 (and 301/302 after POST) becomes a body-less GET.
function followUp(init: FetchInit, status: number, dropped: Set<string> | null): FetchInit {
  const method = (init.method ?? 'GET').toUpperCase();
  const toGet =
    (status === 303 && method !== 'GET' && method !== 'HEAD') ||
    ((status === 301 || status === 302) && method === 'POST');
  const next: FetchInit = toGet
    ? {
        method: 'GET',
        headers: withoutHeaders(init.headers, BODY_HEADERS),
        ...(init.signal ? { signal: init.signal } : {}),
      }
    : init;
  return dropped ? { ...next, headers: withoutHeaders(next.headers, dropped) } : next;
}

function namingRedirect(err: unknown, url: URL, from: string | undefined): unknown {
  return from && err instanceof ActionError && err.code === 'ssrf_blocked'
    ? ssrfRefusal(targetHost(url), from)
    : err;
}

/** The SDK's network hop: fetch, except every dialled address must be public, every redirect hop is re-guarded, the credential never leaves its origin, and Node's env proxy is honoured. */
export const guardedFetch: FetchLike = async (input, init = {}) => {
  let url = requestUrl(input);
  let request: FetchInit = { ...init, headers: { ...init.headers } };
  let from: string | undefined;
  const offOriginDropped = new Set([
    ...CROSS_ORIGIN_DROPPED_HEADERS,
    ...(init.credentialHeaders ?? []).map((name) => name.toLowerCase()),
  ]);
  let leftOrigin = false;
  for (let hops = 0; ; hops += 1) {
    let res: Response;
    try {
      res = await send(url, request);
    } catch (err) {
      throw namingRedirect(err, url, from);
    }
    const location = res.headers.get('location');
    if (init.redirect === 'manual' || !REDIRECT_STATUSES.has(res.status) || location === null) return res;
    await res.body?.cancel();
    if (hops === MAX_REDIRECTS) {
      throw new ActionError({
        code: 'http_error',
        message: `too many redirects from ${url.origin}`,
        retryable: false,
      });
    }
    const next = redirectTarget(location, url);
    leftOrigin ||= next.origin !== url.origin;
    request = followUp(request, res.status, leftOrigin ? offOriginDropped : null);
    if (leftOrigin && init.credentialBody && request.body !== undefined) {
      throw new ActionError({
        code: 'credential_scope',
        message: `refusing to replay a credential-bearing body to ${next.origin} on a ${res.status} redirect`,
        retryable: false,
      });
    }
    if (leftOrigin) withoutParams(next, init.credentialParams ?? []);
    from = url.origin;
    url = next;
  }
};
