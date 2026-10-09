import { Agent, fetch, type Response } from 'undici';

import { ActionError } from '../errors';
import { preflightTarget, ssrfAllowedHostsFromEnv, ssrfSafeLookup } from './ssrf';
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

const dispatcher = new Agent({ connect: { lookup: ssrfSafeLookup } });

function withoutHeaders(
  headers: Record<string, string> | undefined,
  names: Set<string>,
): Record<string, string> {
  return Object.fromEntries(Object.entries(headers ?? {}).filter(([name]) => !names.has(name.toLowerCase())));
}

function withoutParams(url: URL, names: readonly string[]): void {
  for (const name of names) if (url.searchParams.has(name)) url.searchParams.delete(name);
}

async function send(url: URL, { method, headers, body, signal }: FetchInit): Promise<Response> {
  preflightTarget(url, ssrfAllowedHostsFromEnv());
  try {
    return await fetch(url, { method, headers, body, signal, redirect: 'manual', dispatcher });
  } catch (err) {
    const cause = (err as { cause?: unknown }).cause;
    throw cause instanceof ActionError ? cause : err;
  }
}

function redirectTarget(location: string, from: URL): URL {
  let next: URL;
  try {
    next = new URL(location, from);
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
  return next;
}

/** Fetch's own rewrite of a redirected request: 303 (and 301/302 after POST) becomes a body-less GET. */
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

/** The SDK's network hop: fetch, except every dialled address must be public, every redirect hop is re-guarded, and the credential never leaves its origin. */
export const guardedFetch: FetchLike = async (input, init = {}) => {
  let url = new URL(String(input));
  let request = init;
  const offOriginDropped = new Set([
    ...CROSS_ORIGIN_DROPPED_HEADERS,
    ...(init.credentialHeaders ?? []).map((name) => name.toLowerCase()),
  ]);
  let leftOrigin = false;
  for (let hops = 0; ; hops += 1) {
    const res = await send(url, request);
    const location = res.headers.get('location');
    if (!REDIRECT_STATUSES.has(res.status) || location === null) return res;
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
    if (leftOrigin) withoutParams(next, init.credentialParams ?? []);
    url = next;
  }
};
