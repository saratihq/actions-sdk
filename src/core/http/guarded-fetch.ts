import { isNativeError } from 'node:util/types';

import { fetch, type Response } from 'undici';

import { ActionError, transportFailure } from '../errors';
import { egressDispatcher } from './egress';
import { allowedHosts, preflightTarget, ssrfRefusal, targetHost } from './ssrf';
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

function withoutHeaders(
  headers: Record<string, string> | undefined,
  names: Set<string>,
): Record<string, string> {
  return Object.fromEntries(Object.entries(headers ?? {}).filter(([name]) => !names.has(name.toLowerCase())));
}

async function send(url: URL, { method, headers, body, signal }: FetchInit): Promise<Response> {
  preflightTarget(url, allowedHosts());
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
    const cause = (err as { cause?: unknown }).cause;
    if (cause instanceof ActionError) throw cause;
    if (isNativeError(cause)) throw transportFailure(url.origin, cause, 'request');
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
      message: `invalid URL: "${String(input).replace(/\/\/[^/@\s]*@/, '//')}"`,
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
function followUp(init: FetchInit, status: number, crossOrigin: boolean): FetchInit {
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
  return crossOrigin
    ? { ...next, headers: withoutHeaders(next.headers, CROSS_ORIGIN_DROPPED_HEADERS) }
    : next;
}

function namingRedirect(err: unknown, url: URL, from: string | undefined): unknown {
  return from && err instanceof ActionError && err.code === 'ssrf_blocked'
    ? ssrfRefusal(targetHost(url), from)
    : err;
}

/** The SDK's network hop: fetch, except every dialled address must be public, every redirect hop is re-guarded, and Node's env proxy is honoured. */
export const guardedFetch: FetchLike = async (input, init = {}) => {
  let url = requestUrl(input);
  let request = init;
  let from: string | undefined;
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
    request = followUp(request, res.status, next.origin !== url.origin);
    from = url.origin;
    url = next;
  }
};
