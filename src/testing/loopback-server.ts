import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

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

/** Run `fn` with ORCHESTR_HTTP_ALLOWED_HOSTS set to `hosts`, restoring the previous value after. */
export async function withAllowedHosts<T>(hosts: string, fn: () => Promise<T>): Promise<T> {
  const saved = process.env.ORCHESTR_HTTP_ALLOWED_HOSTS;
  process.env.ORCHESTR_HTTP_ALLOWED_HOSTS = hosts;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.ORCHESTR_HTTP_ALLOWED_HOSTS;
    else process.env.ORCHESTR_HTTP_ALLOWED_HOSTS = saved;
  }
}
