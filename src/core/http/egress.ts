import { isIP, type Socket } from 'node:net';

import { Agent, buildConnector, type Dispatcher, Pool } from 'undici';

import { ActionError } from '../errors';
import {
  allowedHosts,
  isBlockedIp,
  publicAddress,
  SSRF_ALLOWLIST_ENV,
  ssrfRefusal,
  ssrfSafeLookup,
} from './ssrf';

const PROXY_VARS = ['http_proxy', 'HTTP_PROXY', 'https_proxy', 'HTTPS_PROXY', 'no_proxy', 'NO_PROXY'];

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
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ActionError({
      code: 'invalid_input',
      message: `${name} is not a valid proxy URL`,
      retryable: false,
    });
  }
  const headers: Record<string, string> = {};
  if (url.username || url.password) {
    const credentials = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;
    headers['proxy-authorization'] = `Basic ${Buffer.from(credentials).toString('base64')}`;
  }
  return { pool: new Pool(url.origin), headers };
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

async function tunnelTarget(hostname: string): Promise<string> {
  if (allowedHosts().includes(hostname)) return hostname;
  if (isIP(hostname)) {
    if (isBlockedIp(hostname)) throw ssrfRefusal(hostname);
    return hostname;
  }
  try {
    return await publicAddress(hostname);
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

// CONNECT to the address judged here, so the proxy never resolves a name of its own.
async function tunnel(
  proxy: Proxy,
  opts: buildConnector.Options,
  hostname: string,
  port: number,
  overTunnel: buildConnector.connector,
): Promise<Socket> {
  const origin = `${opts.protocol}//${opts.host ?? opts.hostname}`;
  const target = await tunnelTarget(hostname);
  const authority = `${isIP(target) === 6 ? `[${target}]` : target}:${port}`;
  let connected: Dispatcher.ConnectData;
  try {
    connected = await proxy.pool.connect({ path: authority, headers: { ...proxy.headers, host: authority } });
  } catch (cause) {
    throw new ActionError({
      code: 'transport_unreachable',
      message: `the egress proxy could not be reached on the way to ${origin}`,
      retryable: true,
      cause,
      detail: { origin, reason: 'the egress proxy could not be reached' },
    });
  }
  if (connected.statusCode !== 200) {
    connected.socket.destroy();
    throw new ActionError({
      code: 'transport_unreachable',
      message: `the egress proxy refused the tunnel to ${origin} (${connected.statusCode})`,
      retryable: connected.statusCode >= 500,
      detail: { origin, reason: `the egress proxy refused the tunnel (${connected.statusCode})` },
    });
  }
  // undici types the tunnel as a Duplex; at runtime it is the net.Socket the proxy connection rides on.
  const socket = connected.socket as Socket;
  if (opts.protocol !== 'https:') return socket;
  return new Promise<Socket>((resolve, reject) => {
    overTunnel({ ...opts, servername: opts.servername || hostname, httpSocket: socket }, (...result) => {
      if (result[0] === null) resolve(result[1]);
      else reject(result[0]);
    });
  });
}

function proxiedConnector(
  proxies: Record<'http:' | 'https:', Proxy | null>,
  noProxy: NoProxy,
): buildConnector.connector {
  const direct = buildConnector({ lookup: ssrfSafeLookup });
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
      (err: unknown) => callback(err instanceof Error ? err : new Error(String(err)), null),
    );
  };
}

function createEgress(key: string, proxied: boolean): Egress {
  if (!proxied) {
    const dispatcher = new Agent({ connect: buildConnector({ lookup: ssrfSafeLookup }) });
    return { key, dispatcher, close: () => dispatcher.close() };
  }
  const httpProxy = proxyFor('HTTP_PROXY', envValue('http_proxy', 'HTTP_PROXY'));
  const httpsProxy = proxyFor('HTTPS_PROXY', envValue('https_proxy', 'HTTPS_PROXY')) ?? httpProxy;
  const noProxy = parseNoProxy(process.env.no_proxy ?? process.env.NO_PROXY ?? '');
  const dispatcher = new Agent({
    connect: proxiedConnector({ 'http:': httpProxy, 'https:': httpsProxy }, noProxy),
  });
  const pools = [...new Set([httpProxy, httpsProxy])].flatMap((proxy) => (proxy ? [proxy.pool] : []));
  return {
    key,
    dispatcher,
    close: () => Promise.all([dispatcher.close(), ...pools.map((pool) => pool.close())]),
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
  void egress?.close().catch(() => undefined);
  egress = createEgress(key, proxied);
  return egress.dispatcher;
}
