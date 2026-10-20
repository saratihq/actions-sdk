import {
  type ConnectProxy,
  type LoopbackServer,
  startConnectProxy,
  startLoopbackServer,
  withEnv,
} from '../../testing/loopback-server';
import { createDirectAuth } from '../auth-factories';
import { HttpClient } from './client';
import { guardedFetch } from './guarded-fetch';

// A second at a time, yielding to I/O between, so the response reaches undici as it would in real time.
async function elapse(ms: number): Promise<void> {
  for (let at = 0; at < ms; at += 1_000) {
    await jest.advanceTimersByTimeAsync(1_000);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

// Fake timers before undici's first request in this file, so its own timer clock runs on them too.
describe('egress — how long a request waits on a server that stalls', () => {
  let server: LoopbackServer;
  let proxy: ConnectProxy;
  let reached: () => void = () => undefined;

  beforeAll(async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    server = await startLoopbackServer((_req, res, hit) => {
      if (hit.url === '/stalled-body') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('{"text":', () => reached());
        return;
      }
      reached();
    });
    proxy = await startConnectProxy(server.port);
  });

  afterAll(async () => {
    await proxy.close();
    await server.close();
    jest.useRealTimers();
  });

  const unproxied = {
    NODE_USE_ENV_PROXY: undefined,
    HTTP_PROXY: undefined,
    HTTPS_PROXY: undefined,
    http_proxy: undefined,
    https_proxy: undefined,
    NO_PROXY: undefined,
    no_proxy: undefined,
  };
  const route = {
    directly: () => ({
      origin: `http://127.0.0.1:${server.port}`,
      env: { ...unproxied, ORCHESTR_HTTP_ALLOWED_HOSTS: '127.0.0.1' },
    }),
    'through an env proxy': () => ({
      origin: 'http://93.184.215.14',
      env: {
        ...unproxied,
        NODE_USE_ENV_PROXY: '1',
        HTTP_PROXY: `http://localhost:${proxy.port}`,
        ORCHESTR_HTTP_ALLOWED_HOSTS: '',
      },
    }),
  };

  it.each([
    ['directly', 'sends nothing back', '/no-headers'],
    ['directly', 'sends headers, then stalls the body', '/stalled-body'],
    ['through an env proxy', 'sends nothing back', '/no-headers'],
    ['through an env proxy', 'sends headers, then stalls the body', '/stalled-body'],
  ] as const)(
    "sent %s to a server that %s, still waits at 599 s, past undici's 300 s defaults, and ends at its own 600 s timeout, sent once",
    async (via, _, path) => {
      const { origin, env } = route[via]();
      const before = server.hits.length;
      const arrived = new Promise<void>((resolve) => {
        reached = resolve;
      });
      await withEnv(env, async () => {
        let settled = false;
        const outcome = new HttpClient()
          .post(`${origin}${path}`, {
            auth: createDirectAuth({ type: 'none' }, { type: 'none' }),
            body: { prompt: 'x' },
            timeoutMs: 600_000,
          })
          .then(
            () => 'answered',
            (err: unknown) => err,
          )
          .finally(() => {
            settled = true;
          });
        await arrived;
        await elapse(599_000);
        expect(settled).toBe(false);
        await elapse(1_000);
        await expect(outcome).resolves.toMatchObject({
          code: 'transport_timeout',
          message: 'request timed out after 600000ms',
        });
      });
      expect(server.hits.slice(before).map((hit) => hit.url)).toEqual([path]);
    },
  );

  const undiciTimer = { '/no-headers': 'UND_ERR_HEADERS_TIMEOUT', '/stalled-body': 'UND_ERR_BODY_TIMEOUT' };
  const signals = {
    'no signal': () => ({}),
    'a signal that never aborts': () => ({ signal: new AbortController().signal }),
  };

  it.each([
    ['directly', 'sends nothing back', '/no-headers', 'no signal'],
    ['directly', 'sends headers, then stalls the body', '/stalled-body', 'no signal'],
    ['through an env proxy', 'sends nothing back', '/no-headers', 'no signal'],
    ['through an env proxy', 'sends headers, then stalls the body', '/stalled-body', 'no signal'],
    ['directly', 'sends nothing back', '/no-headers', 'a signal that never aborts'],
    ['directly', 'sends headers, then stalls the body', '/stalled-body', 'a signal that never aborts'],
    ['through an env proxy', 'sends nothing back', '/no-headers', 'a signal that never aborts'],
    [
      'through an env proxy',
      'sends headers, then stalls the body',
      '/stalled-body',
      'a signal that never aborts',
    ],
  ] as const)(
    "guardedFetch sent %s to a server that %s (%s), with %s, still waits at 299 s and ends at undici's 300 s timer, sent once",
    async (via, _, path, signal) => {
      const { origin, env } = route[via]();
      const before = server.hits.length;
      const arrived = new Promise<void>((resolve) => {
        reached = resolve;
      });
      await withEnv(env, async () => {
        let settled = false;
        const response = guardedFetch(`${origin}${path}`, { method: 'GET', ...signals[signal]() });
        const outcome = response
          .then((res) => res.text())
          .then(
            () => 'answered',
            (err: unknown) => err,
          )
          .finally(() => {
            settled = true;
          });
        await arrived;
        // undici starts its body timer only once the headers reach it, a few I/O turns later through the proxy.
        if (path === '/stalled-body') await response;
        await elapse(299_000);
        expect(settled).toBe(false);
        await elapse(2_000);
        expect(settled).toBe(true);
        await expect(outcome).resolves.toMatchObject({ cause: { code: undiciTimer[path] } });
      });
      expect(server.hits.slice(before).map((hit) => hit.url)).toEqual([path]);
    },
  );
});
