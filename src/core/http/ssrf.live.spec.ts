import { fetch as unguardedFetch } from 'undici';

import { sendRequest } from '../../actions/http/http';
import { createDirectAuth } from '../auth-factories';
import { liveDescribe } from '../../testing/live';
import {
  type LoopbackServer,
  startConnectProxy,
  startLoopbackServer,
  withAllowedHosts,
  withEnv,
} from '../../testing/loopback-server';

/** LIVE: the SSRF bypasses against a real 127.0.0.1 server and real public redirects (httpbin.org); gated behind ORCHESTR_LIVE. */
liveDescribe('SSRF guard — live, real sockets', () => {
  const auth = createDirectAuth({ type: 'none' }, { type: 'none' });
  let server: LoopbackServer;

  beforeAll(async () => {
    server = await startLoopbackServer();
  });

  afterAll(() => server.close());

  const send = (url: string): Promise<unknown> =>
    withAllowedHosts('', () => sendRequest.execute({ auth, props: { method: 'GET', url } }));

  it('the hex IPv4-mapped literal really reaches a 127.0.0.1-only server when unguarded', async () => {
    const res = await unguardedFetch(`http://[::ffff:127.0.0.1]:${server.port}/control`);
    expect(await res.text()).toBe('reached');
    expect(server.hits.map((h) => h.url)).toEqual(['/control']);
  });

  it('http.send_request refuses that same literal, and the server is not reached', async () => {
    const before = server.hits.length;
    await expect(send(`http://[::ffff:127.0.0.1]:${server.port}/latest/meta-data`)).rejects.toMatchObject({
      code: 'ssrf_blocked',
    });
    expect(server.hits).toHaveLength(before);
  });

  it('http.send_request refuses a public URL that 302s to the private server', async () => {
    const before = server.hits.length;
    const target = encodeURIComponent(`http://127.0.0.1:${server.port}/secret`);
    await expect(send(`https://httpbin.org/redirect-to?url=${target}&status_code=302`)).rejects.toMatchObject(
      {
        code: 'ssrf_blocked',
      },
    );
    expect(server.hits).toHaveLength(before);
  });

  it('http.send_request still reaches a public URL, following a public redirect', async () => {
    const target = encodeURIComponent('https://httpbin.org/get?proof=guarded');
    const out = (await send(`https://httpbin.org/redirect-to?url=${target}&status_code=302`)) as {
      status: number;
      body: { args?: Record<string, string> };
    };
    expect(out.status).toBe(200);
    expect(out.body.args).toEqual({ proof: 'guarded' });
  });

  const proxyEnv = (proxy: Record<string, string>): Record<string, string | undefined> => ({
    NODE_USE_ENV_PROXY: '1',
    HTTP_PROXY: undefined,
    HTTPS_PROXY: undefined,
    http_proxy: undefined,
    https_proxy: undefined,
    NO_PROXY: undefined,
    no_proxy: undefined,
    ORCHESTR_HTTP_ALLOWED_HOSTS: '',
    ...proxy,
  });

  it('behind an env proxy, judges a real public name here and tunnels to the address it judged', async () => {
    const proxy = await startConnectProxy(server.port);
    try {
      const env = proxyEnv({ HTTP_PROXY: `http://localhost:${proxy.port}` });
      const out = (await withEnv(env, () =>
        sendRequest.execute({ auth, props: { method: 'GET', url: 'http://example.com/via-proxy' } }),
      )) as { status: number };
      expect(out.status).toBe(200);
      expect(proxy.tunnels).toHaveLength(1);
      expect(proxy.tunnels[0]).toMatch(/^(\d+\.){3}\d+:80$|^\[[0-9a-f:]+\]:80$/);
      await expect(
        withEnv(env, () =>
          sendRequest.execute({ auth, props: { method: 'GET', url: 'http://localtest.me/' } }),
        ),
      ).rejects.toMatchObject({ code: 'ssrf_blocked' });
      expect(proxy.tunnels).toHaveLength(1);
    } finally {
      await proxy.close();
    }
  });

  it('behind an env proxy, reaches a real https site through a tunnel to the judged address, TLS verified on the name', async () => {
    const forwarding = await startConnectProxy((authority) => {
      const split = authority.lastIndexOf(':');
      return {
        host: authority.slice(0, split).replace(/^\[|\]$/g, ''),
        port: Number(authority.slice(split + 1)),
      };
    });
    try {
      const env = proxyEnv({ HTTPS_PROXY: `http://localhost:${forwarding.port}` });
      const out = (await withEnv(env, () =>
        sendRequest.execute({ auth, props: { method: 'GET', url: 'https://example.com/' } }),
      )) as { status: number; body: unknown };
      expect(out.status).toBe(200);
      expect(String(out.body)).toContain('Example Domain');
      expect(forwarding.tunnels).toHaveLength(1);
      expect(forwarding.tunnels[0]).toMatch(/^(\d+\.){3}\d+:443$|^\[[0-9a-f:]+\]:443$/);
    } finally {
      await forwarding.close();
    }
  });
});
