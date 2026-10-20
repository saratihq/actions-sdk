import {
  type ConnectProxy,
  type LoopbackServer,
  startConnectProxy,
  startLoopbackServer,
  withEnv,
} from '../../testing/loopback-server';
import { createDirectAuth } from '../auth-factories';
import { HttpClient } from './client';

// Fake timers before undici's first request in this file, so its own timer clock runs on them too.
describe('egress — a request waits on the server until its own deadline', () => {
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
    "sent %s, outlives undici's 300 s defaults when the server %s, and ends at its own 600 s timeout, sent once",
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
        await jest.advanceTimersByTimeAsync(301_000);
        expect(settled).toBe(false);
        await jest.advanceTimersByTimeAsync(299_000);
        await expect(outcome).resolves.toMatchObject({
          code: 'transport_timeout',
          message: 'request timed out after 600000ms',
        });
      });
      expect(server.hits.slice(before).map((hit) => hit.url)).toEqual([path]);
    },
  );
});
