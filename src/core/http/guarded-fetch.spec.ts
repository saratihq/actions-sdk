import {
  type ConnectProxy,
  type LoopbackServer,
  startConnectProxy,
  startLoopbackServer,
  withAllowedHosts,
  withEnv,
} from '../../testing/loopback-server';
import { guardedFetch } from './guarded-fetch';
import { ssrfSafeLookup } from './ssrf';

describe('guardedFetch', () => {
  let server: LoopbackServer;
  let base: string;

  beforeEach(async () => {
    server = await startLoopbackServer((req, res, hit) => {
      const [path, query] = hit.url.split('?');
      const to = new URLSearchParams(query).get('to');
      if (path === '/redirect' && to) {
        res.writeHead(Number(new URLSearchParams(query).get('status') ?? 302), { location: to });
        res.end();
        return;
      }
      if (path === '/utf8') {
        res.writeHead(302, { location: Buffer.from('/café?q=ü', 'utf8').toString('latin1') });
        res.end();
        return;
      }
      if (path === '/loop') {
        res.writeHead(302, { location: '/loop' });
        res.end();
        return;
      }
      res.end(`reached ${req.method} ${path}`);
    });
    base = `127.0.0.1:${server.port}`;
  });

  afterEach(() => server.close());

  it.each([
    ['the hex IPv4-mapped literal', () => `http://[::ffff:127.0.0.1]:${server.port}/`],
    ['the IPv4-compatible literal', () => `http://[::127.0.0.1]:${server.port}/`],
    [
      'a hostname that resolves to loopback (checked as it is dialled)',
      () => `http://localhost:${server.port}/`,
    ],
    ['a plain loopback literal', () => `http://${base}/`],
  ])('refuses %s without reaching the server', async (_label, url) => {
    await withAllowedHosts('', async () => {
      await expect(guardedFetch(url())).rejects.toMatchObject({ code: 'ssrf_blocked' });
    });
    expect(server.hits).toHaveLength(0);
  });

  it('reaches an allowlisted host', async () => {
    const res = await withAllowedHosts('127.0.0.1', () => guardedFetch(`http://${base}/ok`));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('reached GET /ok');
  });

  it('re-guards every redirect hop: an allowed origin cannot 302 to a private address', async () => {
    const to = encodeURIComponent(`http://${base}/secret`);
    await withAllowedHosts('localhost', async () => {
      await expect(guardedFetch(`http://localhost:${server.port}/redirect?to=${to}`)).rejects.toMatchObject({
        code: 'ssrf_blocked',
        message: expect.stringContaining(`(127.0.0.1, redirected from http://localhost:${server.port})`),
      });
    });
    expect(server.hits.map((h) => h.url)).toEqual([`/redirect?to=${to}`]);
  });

  it('refuses a redirect to the hex IPv4-mapped spelling of an allowlisted address', async () => {
    const to = encodeURIComponent(`http://[::ffff:127.0.0.1]:${server.port}/secret`);
    await withAllowedHosts('127.0.0.1', async () => {
      await expect(guardedFetch(`http://${base}/redirect?to=${to}`)).rejects.toMatchObject({
        code: 'ssrf_blocked',
      });
    });
    expect(server.hits).toHaveLength(1);
  });

  it('refuses a redirect to a non-http(s) scheme', async () => {
    const to = encodeURIComponent('file:///etc/passwd');
    await withAllowedHosts('127.0.0.1', async () => {
      await expect(guardedFetch(`http://${base}/redirect?to=${to}`)).rejects.toMatchObject({
        code: 'ssrf_blocked',
      });
    });
  });

  it('refuses a redirect to a URL carrying credentials without echoing them', async () => {
    const to = encodeURIComponent(`http://user:hunter2@${base}/landing`);
    const failure = await withAllowedHosts('127.0.0.1', () =>
      guardedFetch(`http://${base}/redirect?to=${to}`).catch((err: unknown) => err),
    );
    expect(failure).toMatchObject({ code: 'http_error' });
    expect(String((failure as Error).message)).not.toContain('hunter2');
    expect(server.hits).toHaveLength(1);
  });

  it('names the refused host but never the private address it resolved to', async () => {
    await withAllowedHosts('', async () => {
      const failure = await guardedFetch(`http://localhost:${server.port}/`).catch((err: unknown) => err);
      expect((failure as Error).message).toContain('(localhost)');
      expect((failure as Error).message).toContain('adding localhost to ORCHESTR_HTTP_ALLOWED_HOSTS');
      expect((failure as Error).message).not.toMatch(/127\.0\.0\.1|::1/);
    });
  });

  it('follows an allowed redirect, rewriting a 303 POST to a body-less GET', async () => {
    const to = encodeURIComponent('/landing');
    const res = await withAllowedHosts('127.0.0.1', () =>
      guardedFetch(`http://${base}/redirect?status=303&to=${to}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"a":1}',
      }),
    );
    expect(await res.text()).toBe('reached GET /landing');
    expect(server.hits[1]).toMatchObject({ method: 'GET', body: '' });
    expect(server.hits[1]?.headers['content-type']).toBeUndefined();
  });

  it('keeps the method and body across a 307', async () => {
    const to = encodeURIComponent('/landing');
    const res = await withAllowedHosts('127.0.0.1', () =>
      guardedFetch(`http://${base}/redirect?status=307&to=${to}`, { method: 'POST', body: 'payload' }),
    );
    expect(await res.text()).toBe('reached POST /landing');
    expect(server.hits[1]).toMatchObject({ method: 'POST', body: 'payload' });
  });

  it('drops credentials on a cross-origin hop and keeps them on a same-origin one', async () => {
    const cross = encodeURIComponent(`http://localhost:${server.port}/landing`);
    await withAllowedHosts('127.0.0.1,localhost', async () => {
      await guardedFetch(`http://${base}/redirect?to=${cross}`, { headers: { Authorization: 'Bearer t' } });
      await guardedFetch(`http://${base}/redirect?to=%2Fsame`, { headers: { authorization: 'Bearer t' } });
    });
    expect(server.hits.map((h) => [h.url.split('?')[0], h.headers.authorization])).toEqual([
      ['/redirect', 'Bearer t'],
      ['/landing', undefined],
      ['/redirect', 'Bearer t'],
      ['/same', 'Bearer t'],
    ]);
  });

  it('stops after 20 redirects', async () => {
    await withAllowedHosts('127.0.0.1', async () => {
      await expect(guardedFetch(`http://${base}/loop`)).rejects.toMatchObject({ code: 'http_error' });
    });
    expect(server.hits).toHaveLength(21);
  });

  it('fails a name that does not resolve without sending anything', async () => {
    await expect(guardedFetch('http://does-not-exist.invalid/')).rejects.toMatchObject({
      code: 'transport_unreachable',
      message: expect.stringContaining('could not reach http://does-not-exist.invalid: getaddrinfo'),
    });
  });
});

describe('guardedFetch — request shape and failures', () => {
  let server: LoopbackServer;
  let base: string;

  beforeEach(async () => {
    server = await startLoopbackServer((req, res, hit) => {
      if (hit.url.startsWith('/redirect')) {
        res.writeHead(307, { location: '/landing' });
        res.end();
        return;
      }
      if (hit.url === '/utf8') {
        res.writeHead(302, { location: Buffer.from('/café?q=ü', 'utf8').toString('latin1') });
        res.end();
        return;
      }
      res.end(`reached ${req.method} ${hit.url}`);
    });
    base = `127.0.0.1:${server.port}`;
  });

  afterEach(() => server.close());

  it('says why a hop could not be reached, naming the origin and never its path or query', async () => {
    const closed = await startLoopbackServer();
    const { port } = closed;
    await closed.close();
    const failure = await withAllowedHosts('127.0.0.1', () =>
      guardedFetch(`http://127.0.0.1:${port}/private-path?token=abc`).catch((err: unknown) => err),
    );
    expect(failure).toMatchObject({ code: 'transport_unreachable', retryable: true });
    expect((failure as Error).message).toBe(
      `could not reach http://127.0.0.1:${port}: connect ECONNREFUSED 127.0.0.1:${port}`,
    );
    expect((failure as Error).cause).toMatchObject({ code: 'ECONNREFUSED' });
  });

  it('hands back a redirect unfollowed when asked to, so a POST body is never re-sent', async () => {
    const res = await withAllowedHosts('127.0.0.1', () =>
      guardedFetch(`http://${base}/redirect`, { method: 'POST', body: 'secret=1', redirect: 'manual' }),
    );
    expect(res.status).toBe(307);
    expect(server.hits.map((h) => h.url)).toEqual(['/redirect']);
  });

  it('follows a raw UTF-8 Location to the URL it names', async () => {
    const res = await withAllowedHosts('127.0.0.1', () => guardedFetch(`http://${base}/utf8`));
    expect(await res.text()).toBe('reached GET /caf%C3%A9?q=%C3%BC');
    expect(server.hits.map((h) => h.url)).toEqual(['/utf8', '/caf%C3%A9?q=%C3%BC']);
  });

  it.each(['example.com/api', 'not a url'])(
    'refuses %s as invalid input, not as a retryable failure',
    async (url) => {
      await expect(guardedFetch(url)).rejects.toMatchObject({
        code: 'invalid_input',
        retryable: false,
        message: `invalid URL: "${url}"`,
      });
    },
  );

  it('refuses a URL carrying a username or password without echoing it', async () => {
    const failure = await withAllowedHosts('127.0.0.1', () =>
      guardedFetch(`http://user:hunter2@${base}/`).catch((err: unknown) => err),
    );
    expect(failure).toMatchObject({ code: 'invalid_input', retryable: false });
    expect((failure as Error).message).not.toContain('hunter2');
    expect(server.hits).toHaveLength(0);
  });

  it('opens a fresh pool when the allowlist changes, so a socket vetted under the old one is not reused', async () => {
    await withAllowedHosts('localhost', async () => {
      await (await guardedFetch(`http://localhost:${server.port}/first`)).text();
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await withAllowedHosts('', async () => {
      await expect(guardedFetch(`http://localhost:${server.port}/second`)).rejects.toMatchObject({
        code: 'ssrf_blocked',
      });
    });
    expect(server.hits.map((h) => h.url)).toEqual(['/first']);
  });
});

describe('guardedFetch — behind an env proxy', () => {
  let server: LoopbackServer;
  let proxy: ConnectProxy;

  const proxyEnv = (extra: Record<string, string | undefined> = {}): Record<string, string | undefined> => ({
    NODE_USE_ENV_PROXY: '1',
    HTTP_PROXY: `http://127.0.0.1:${proxy.port}`,
    HTTPS_PROXY: undefined,
    http_proxy: undefined,
    https_proxy: undefined,
    NO_PROXY: undefined,
    no_proxy: undefined,
    ORCHESTR_HTTP_ALLOWED_HOSTS: '',
    ...extra,
  });

  beforeEach(async () => {
    server = await startLoopbackServer();
    proxy = await startConnectProxy(server.port);
  });

  afterEach(async () => {
    await proxy.close();
    await server.close();
  });

  it('sends a public target through the proxy, and never judges the proxy itself', async () => {
    const res = await withEnv(proxyEnv(), () => guardedFetch('http://93.184.215.14/through'));
    expect(await res.text()).toBe('reached');
    expect(proxy.tunnels).toEqual(['93.184.215.14:80']);
    expect(server.hits.map((h) => h.url)).toEqual(['/through']);
  });

  it.each([
    ['a name resolving to loopback', () => `http://localhost:${server.port}/`],
    ['the hex IPv4-mapped literal', () => `http://[::ffff:127.0.0.1]:${server.port}/`],
  ])('judges %s on this server before asking the proxy', async (_label, url) => {
    await withEnv(proxyEnv(), async () => {
      await expect(guardedFetch(url())).rejects.toMatchObject({ code: 'ssrf_blocked' });
    });
    expect(proxy.tunnels).toEqual([]);
    expect(server.hits).toHaveLength(0);
  });

  it('refuses a proxied name this server cannot resolve, since it cannot be judged', async () => {
    await withEnv(proxyEnv(), async () => {
      await expect(guardedFetch('http://does-not-exist.invalid/')).rejects.toMatchObject({
        code: 'unresolvable_host',
      });
    });
    expect(proxy.tunnels).toEqual([]);
  });

  it('goes direct for a NO_PROXY host', async () => {
    const res = await withEnv(
      proxyEnv({ NO_PROXY: 'localhost', ORCHESTR_HTTP_ALLOWED_HOSTS: 'localhost' }),
      () => guardedFetch(`http://localhost:${server.port}/direct`),
    );
    expect(res.status).toBe(200);
    expect(proxy.tunnels).toEqual([]);
    expect(server.hits.map((h) => h.url)).toEqual(['/direct']);
  });

  it('ignores HTTP_PROXY unless Node is told to use the env proxy, as Node fetch does', async () => {
    const res = await withEnv(
      proxyEnv({ NODE_USE_ENV_PROXY: undefined, ORCHESTR_HTTP_ALLOWED_HOSTS: '127.0.0.1' }),
      () => guardedFetch(`http://127.0.0.1:${server.port}/direct`),
    );
    expect(res.status).toBe(200);
    expect(proxy.tunnels).toEqual([]);
  });
});

describe('ssrfSafeLookup', () => {
  const resolve = (hostname: string, all: boolean): Promise<unknown> =>
    new Promise((ok, fail) => {
      ssrfSafeLookup(hostname, { all }, (err, address, family) =>
        err ? fail(err) : ok({ address, family }),
      );
    });

  it('refuses a name resolving to loopback in both lookup shapes', async () => {
    await withAllowedHosts('', async () => {
      await expect(resolve('localhost', true)).rejects.toMatchObject({ code: 'ssrf_blocked' });
      await expect(resolve('localhost', false)).rejects.toMatchObject({ code: 'ssrf_blocked' });
    });
  });

  it('answers an allowlisted name in the shape net.connect asked for', async () => {
    await withAllowedHosts('localhost', async () => {
      await expect(resolve('localhost', true)).resolves.toMatchObject({
        address: expect.arrayContaining([expect.objectContaining({ address: expect.any(String) })]),
      });
      await expect(resolve('localhost', false)).resolves.toMatchObject({ address: expect.any(String) });
    });
  });
});
