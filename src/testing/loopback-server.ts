import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { type AddressInfo, connect, type Socket } from 'node:net';

/** One request a {@link LoopbackServer} received. */
export interface LoopbackHit {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** A real HTTP server bound to 127.0.0.1 only, recording every request that reaches it. */
export interface LoopbackServer {
  port: number;
  hits: LoopbackHit[];
  close(): Promise<void>;
}

/** Start a {@link LoopbackServer}; `handler` answers each request (default: 200 "reached"). */
export async function startLoopbackServer(
  handler: (req: IncomingMessage, res: ServerResponse, hit: LoopbackHit) => void = (_req, res) => {
    res.end('reached');
  },
): Promise<LoopbackServer> {
  const hits: LoopbackHit[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const hit = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      hits.push(hit);
      handler(req, res, hit);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    hits,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Run `fn` with `vars` set (`undefined` unsets one), restoring the previous values after. */
export async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(vars).map((name) => [name, process.env[name]]));
  const apply = (values: Record<string, string | undefined>): void => {
    for (const [name, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
  apply(vars);
  try {
    return await fn();
  } finally {
    apply(saved);
  }
}

/** Run `fn` with ORCHESTR_HTTP_ALLOWED_HOSTS set to `hosts`, restoring the previous value after. */
export function withAllowedHosts<T>(hosts: string, fn: () => Promise<T>): Promise<T> {
  return withEnv({ ORCHESTR_HTTP_ALLOWED_HOSTS: hosts }, fn);
}

/** A CONNECT proxy on 127.0.0.1 that records every tunnel asked of it. */
export interface ConnectProxy {
  port: number;
  tunnels: string[];
  close(): Promise<void>;
}

/** Where a {@link ConnectProxy} sends a tunnel: a port to splice to (on 127.0.0.1 unless `host` says), or a status to refuse it with. */
export type TunnelRoute = { host?: string; port: number } | { status: number };

/** Start a {@link ConnectProxy}; `route` decides each tunnel from the authority it was asked for (a port splices every tunnel there). */
export async function startConnectProxy(
  route: number | ((authority: string, index: number) => TunnelRoute),
): Promise<ConnectProxy> {
  const tunnels: string[] = [];
  const sockets = new Set<Socket>();
  const decide = typeof route === 'number' ? (): TunnelRoute => ({ port: route }) : route;
  const server = createServer((_req, res) => {
    res.writeHead(405);
    res.end();
  });
  server.on('connect', (req: IncomingMessage, client: Socket, head: Buffer) => {
    const authority = req.url ?? '';
    const decision = decide(authority, tunnels.length);
    tunnels.push(authority);
    sockets.add(client);
    client.on('error', () => client.destroy());
    if ('status' in decision) {
      client.end(`HTTP/1.1 ${decision.status} Refused\r\n\r\n`);
      return;
    }
    const upstream = connect(decision.port, decision.host ?? '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    sockets.add(upstream);
    upstream.on('error', () => client.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    tunnels,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
