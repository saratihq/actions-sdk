import { isNativeError } from 'node:util/types';

import { Agent, type Dispatcher, EnvHttpProxyAgent, fetch, type Response } from 'undici';

import { ActionError } from '../errors';
import {
  assertPublicTarget,
  preflightTarget,
  SSRF_ALLOWLIST_ENV,
  ssrfAllowedHostsFromEnv,
  ssrfRefusal,
  ssrfSafeLookup,
  targetHost,
} from './ssrf';
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
const PROXY_URL_VARS = ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy'];
const PROXY_VARS = [...PROXY_URL_VARS, 'NO_PROXY', 'no_proxy'];

interface Route {
  key: string;
  proxied: boolean;
  dispatcher: Dispatcher;
}

let route: Route | null = null;

/** Node's own switch for honouring HTTP(S)_PROXY in fetch: `NODE_USE_ENV_PROXY=1` or `--use-env-proxy`. */
function envProxyEnabled(): boolean {
  const flags = [...process.execArgv, ...(process.env.NODE_OPTIONS ?? '').split(/\s+/)];
  const enabled = process.env.NODE_USE_ENV_PROXY === '1' || flags.includes('--use-env-proxy');
  return enabled && PROXY_URL_VARS.some((name) => Boolean(process.env[name]));
}

// A pooled socket was vetted under the allowlist and proxy settings it was opened with, so a change gets a fresh pool.
function currentRoute(): Route {
  const proxied = envProxyEnabled();
  const key = [
    proxied,
    process.env[SSRF_ALLOWLIST_ENV] ?? '',
    ...PROXY_VARS.map((name) => process.env[name] ?? ''),
  ].join('\n');
  if (route?.key === key) return route;
  void route?.dispatcher.close().catch(() => undefined);
  const connect = { lookup: ssrfSafeLookup };
  route = { key, proxied, dispatcher: proxied ? new EnvHttpProxyAgent({ connect }) : new Agent({ connect }) };
  return route;
}

function withoutHeaders(
  headers: Record<string, string> | undefined,
  names: Set<string>,
): Record<string, string> {
  return Object.fromEntries(Object.entries(headers ?? {}).filter(([name]) => !names.has(name.toLowerCase())));
}

async function send(url: URL, { method, headers, body, signal }: FetchInit): Promise<Response> {
  const { proxied, dispatcher } = currentRoute();
  const allowed = ssrfAllowedHostsFromEnv();
  // Behind a proxy the proxy resolves the name, so the target is judged on this server's resolution before the send.
  if (proxied) await assertPublicTarget(url, allowed);
  else preflightTarget(url, allowed);
  try {
    return await fetch(url, { method, headers, body, signal, redirect: 'manual', dispatcher });
  } catch (err) {
    const cause = (err as { cause?: unknown }).cause;
    if (cause instanceof ActionError) throw cause;
    if (isNativeError(cause)) {
      throw new ActionError({
        code: 'transport_unreachable',
        message: `could not reach ${url.origin}: ${cause.message}`,
        retryable: true,
        cause,
      });
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
      message: `invalid URL: "${String(input)}"`,
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
  return next;
}

/** Fetch's own rewrite of a redirected request: 303 (and 301/302 after POST) becomes a body-less GET. */
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
