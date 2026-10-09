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

  it('behind an env proxy, judges a real public name on this server and tunnels it through the proxy', async () => {
    const proxy = await startConnectProxy(server.port);
    try {
      const env = {
        NODE_USE_ENV_PROXY: '1',
        HTTP_PROXY: `http://127.0.0.1:${proxy.port}`,
        ORCHESTR_HTTP_ALLOWED_HOSTS: '',
      };
      const out = (await withEnv(env, () =>
        sendRequest.execute({ auth, props: { method: 'GET', url: 'http://example.com/via-proxy' } }),
      )) as { status: number };
      expect(out.status).toBe(200);
      expect(proxy.tunnels).toEqual(['example.com:80']);
      await expect(
        withEnv(env, () =>
          sendRequest.execute({ auth, props: { method: 'GET', url: 'http://localtest.me/' } }),
        ),
      ).rejects.toMatchObject({ code: 'ssrf_blocked' });
      expect(proxy.tunnels).toEqual(['example.com:80']);
    } finally {
      await proxy.close();
    }
  });
});
