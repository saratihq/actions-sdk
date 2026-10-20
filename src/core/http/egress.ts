import { isIP, type Socket } from 'node:net';
import { isNativeError } from 'node:util/types';

import { Agent, buildConnector, type Dispatcher, Pool } from 'undici';

import { ActionError, isCertificateFailure, isTlsFailure, neverReached } from '../errors';
import {
  allowedHosts,
  isBlockedIp,
  publicAddresses,
  SSRF_ALLOWLIST_ENV,
  ssrfRefusal,
  ssrfSafeLookup,
} from './ssrf';

const PROXY_VARS = ['http_proxy', 'HTTP_PROXY', 'https_proxy', 'HTTPS_PROXY', 'no_proxy', 'NO_PROXY'];
// A proxy that will not connect or answer a tunnel request within this gives up well inside a request's own budget.
const PROXY_TIMEOUT_MS = 10_000;
// Every request carries the HttpClient's own deadline; undici's 300 s defaults would cut a long model call short.
const REQUEST_TIMERS = { headersTimeout: 0, bodyTimeout: 0 };

interface Proxy {
  pool: Pool;
  headers: Record<string, string>;
}

interface NoProxy {
  raw: string;
  entries: Array<{ hostname: string; port: number }>;
}

interface Egress {
  key: string;
  dispatcher: Dispatcher;
  close(): Promise<unknown>;
}

let egress: Egress | null = null;

// Node's own switch for honouring HTTP(S)_PROXY in fetch: NODE_USE_ENV_PROXY=1 or --use-env-proxy.
function envProxyEnabled(): boolean {
  const flags = [...process.execArgv, ...(process.env.NODE_OPTIONS ?? '').split(/\s+/)];
  return process.env.NODE_USE_ENV_PROXY === '1' || flags.includes('--use-env-proxy');
}

function envValue(lower: string, upper: string): string | undefined {
  return (process.env[lower] ?? process.env[upper]) || undefined;
}

function proxyFor(name: string, raw: string | undefined): Proxy | null {
  if (!raw) return null;
  const refuse = (why: string): ActionError =>
    new ActionError({ code: 'invalid_input', message: `${name} ${why}`, retryable: false });
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw refuse('is not a valid proxy URL');
  }
  if (/^socks/i.test(url.protocol))
    throw refuse('names a SOCKS proxy, which is not supported; use an HTTP or HTTPS proxy');
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw refuse('is not a valid proxy URL: it must start with http:// or https://');
  }
  const headers: Record<string, string> = {};
  if (url.username || url.password) {
    let credentials: string;
    try {
      credentials = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;
    } catch {
      throw refuse('has credentials that are not valid percent-encoding');
    }
    headers['proxy-authorization'] = `Basic ${Buffer.from(credentials).toString('base64')}`;
  }
  // TLS to the proxy is always verified against the proxy's own host, never the target a CONNECT's Host header names.
  const toProxy = buildConnector({ timeout: PROXY_TIMEOUT_MS });
  return {
    pool: new Pool(url.origin, {
      headersTimeout: PROXY_TIMEOUT_MS,
      connect: (opts, callback) => toProxy({ ...opts, servername: undefined }, callback),
    }),
    headers,
  };
}

// NO_PROXY as undici's EnvHttpProxyAgent reads it, so the direct/proxied split matches Node fetch.
function parseNoProxy(raw: string): NoProxy {
  const entries = raw
    .split(/[,\s]/)
    .filter(Boolean)
    .map((entry) => {
      const withPort = /^(.+):(\d+)$/.exec(entry);
      return {
        hostname: (withPort?.[1] ?? entry).replace(/^\*?\./, '').toLowerCase(),
        port: withPort ? Number.parseInt(withPort[2] ?? '0', 10) : 0,
      };
    });
  return { raw, entries };
}

function shouldProxy({ raw, entries }: NoProxy, hostname: string, port: number): boolean {
  if (raw === '*') return false;
  const host = isIP(hostname) === 6 ? `[${hostname}]` : hostname;
  return !entries.some(
    (entry) =>
      (!entry.port || entry.port === port) &&
      (host === entry.hostname || host.endsWith(`.${entry.hostname}`)),
  );
}

async function tunnelTargets(hostname: string): Promise<string[]> {
  if (allowedHosts().includes(hostname)) return [hostname];
  if (isIP(hostname)) {
    if (isBlockedIp(hostname)) throw ssrfRefusal(hostname);
    return [hostname];
  }
  try {
    return await publicAddresses(hostname);
  } catch (err) {
    if (!(err instanceof ActionError) || err.code !== 'unresolvable_host') throw err;
    throw new ActionError({
      code: 'unresolvable_host',
      message: `${err.message}; if the egress proxy can resolve it, an operator can add ${hostname} to ${SSRF_ALLOWLIST_ENV} to send it to the proxy unjudged`,
      retryable: err.retryable,
      cause: err.cause,
    });
  }
}

// What went wrong on the way through the proxy, never naming where the proxy lives.
function proxyFailure(origin: string, cause: unknown): ActionError {
  const { code = '', name = '' } = (cause ?? {}) as { code?: string; name?: string };
  const [reason, retryable] =
    code === 'UND_ERR_HEADERS_TIMEOUT'
      ? ['the egress proxy did not answer the tunnel request', true]
      : isCertificateFailure(cause)
        ? [`the egress proxy's certificate was rejected (${code})`, false]
        : isTlsFailure(cause)
          ? [
              `TLS to the egress proxy failed (${code}); check whether the proxy URL should be http:// or https://`,
              false,
            ]
          : code === 'UND_ERR_HEADERS_OVERFLOW' || name === 'HTTPParserError' || code.startsWith('HPE_')
            ? ['the egress proxy sent an invalid reply', false]
            : code === 'UND_ERR_SOCKET'
              ? [
                  'the egress proxy closed the connection without answering; if it speaks TLS, the proxy URL should be https://',
                  true,
                ]
              : ['the egress proxy could not be reached', true];
  return new ActionError({
    code: 'transport_unreachable',
    message: `${reason} on the way to ${origin}`,
    retryable,
    cause,
    detail: { origin, reason },
  });
}

// CONNECT to an address judged here, so the proxy never resolves a name of its own; a 5xx from the proxy moves on to the next.
async function openTunnel(proxy: Proxy, origin: string, targets: string[], port: number): Promise<Socket> {
  let status = 0;
  for (const target of targets) {
    const authority = `${isIP(target) === 6 ? `[${target}]` : target}:${port}`;
    let connected: Dispatcher.ConnectData;
    try {
      connected = await proxy.pool.connect({
        path: authority,
        headers: { ...proxy.headers, host: authority },
      });
    } catch (cause) {
      throw proxyFailure(origin, cause);
    }
    // undici types the tunnel as a Duplex; at runtime it is the net.Socket the proxy connection rides on.
    if (connected.statusCode === 200) return connected.socket as Socket;
    connected.socket.destroy();
    status = connected.statusCode;
    if (status < 500) break;
  }
  throw new ActionError({
    code: 'transport_unreachable',
    message: `the egress proxy refused the tunnel to ${origin} (${status})`,
    retryable: status >= 500,
    detail: { origin, reason: `the egress proxy refused the tunnel (${status})` },
  });
}

async function tunnel(
  proxy: Proxy,
  opts: buildConnector.Options,
  hostname: string,
  port: number,
  overTunnel: buildConnector.connector,
): Promise<Socket> {
  const origin = `${opts.protocol}//${opts.host ?? opts.hostname}`;
  const socket = await openTunnel(proxy, origin, await tunnelTargets(hostname), port);
  if (opts.protocol !== 'https:') {
    // Bytes ahead of our request mean the far end is not an HTTP server; handing them on makes undici reconnect, CONNECT after CONNECT.
    if (socket.readableLength === 0) return socket;
    socket.destroy();
    throw new ActionError({
      code: 'http_error',
      message: `the tunnel to ${origin} carried data before the request was sent, so it is not answering as an HTTP server`,
      retryable: false,
      detail: { origin, reason: 'data arrived before the request was sent' },
    });
  }
  return new Promise<Socket>((resolve, reject) => {
    overTunnel({ ...opts, httpSocket: socket }, (...result) => {
      if (result[0] === null) resolve(result[1]);
      else reject(neverReached(origin, result[0]));
    });
  });
}

// Everything the connector does happens before the request is written, so any failure in it is a host never reached.
function directConnector(): buildConnector.connector {
  const direct = buildConnector({ lookup: ssrfSafeLookup });
  return (opts, callback) => {
    direct(opts, (...result) => {
      if (result[0] === null) callback(null, result[1]);
      else if (result[0] instanceof ActionError) callback(result[0], null);
      else callback(neverReached(`${opts.protocol}//${opts.host ?? opts.hostname}`, result[0]), null);
    });
  };
}

function proxiedConnector(
  proxies: Record<'http:' | 'https:', Proxy | null>,
  noProxy: NoProxy,
): buildConnector.connector {
  const direct = directConnector();
  const overTunnel = buildConnector({});
  return (opts, callback) => {
    const hostname = opts.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const port = Number(opts.port) || (opts.protocol === 'https:' ? 443 : 80);
    const proxy = opts.protocol === 'https:' ? proxies['https:'] : proxies['http:'];
    if (!proxy || !shouldProxy(noProxy, hostname, port)) {
      direct(opts, callback);
      return;
    }
    tunnel(proxy, opts, hostname, port, overTunnel).then(
      (socket) => callback(null, socket),
      (err: unknown) => callback(isNativeError(err) ? err : new Error(String(err)), null),
    );
  };
}

function createEgress(key: string, proxied: boolean): Egress {
  if (!proxied) {
    const dispatcher = new Agent({ ...REQUEST_TIMERS, connect: directConnector() });
    return { key, dispatcher, close: () => dispatcher.close() };
  }
  const httpProxy = proxyFor('HTTP_PROXY', envValue('http_proxy', 'HTTP_PROXY'));
  const httpsProxy = proxyFor('HTTPS_PROXY', envValue('https_proxy', 'HTTPS_PROXY')) ?? httpProxy;
  const noProxy = parseNoProxy(process.env.no_proxy ?? process.env.NO_PROXY ?? '');
  const dispatcher = new Agent({
    ...REQUEST_TIMERS,
    connect: proxiedConnector({ 'http:': httpProxy, 'https:': httpsProxy }, noProxy),
  });
  const pools = [...new Set([httpProxy, httpsProxy])].flatMap((proxy) => (proxy ? [proxy.pool] : []));
  return {
    key,
    dispatcher,
    close: () => dispatcher.close().then(() => Promise.all(pools.map((pool) => pool.close()))),
  };
}

/** The dispatcher for the current allowlist and proxy env; a change gets a fresh one, since its sockets were vetted under the old settings. */
export function egressDispatcher(): Dispatcher {
  const proxied = envProxyEnabled();
  const key = [
    proxied,
    process.env[SSRF_ALLOWLIST_ENV] ?? '',
    ...PROXY_VARS.map((name) => process.env[name] ?? ''),
  ].join('\n');
  if (egress?.key === key) return egress.dispatcher;
  const next = createEgress(key, proxied);
  const previous = egress;
  egress = next;
  void previous?.close().catch(() => undefined);
  return next.dispatcher;
}
