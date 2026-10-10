import {
  type ConnectProxy,
  type LoopbackServer,
  startConnectProxy,
  startLoopbackServer,
  withAllowedHosts,
  withEnv,
} from '../../testing/loopback-server';
import dns from 'node:dns';
import { isIP } from 'node:net';

import { createDirectAuth } from '../auth-factories';
import { HttpClient } from './client';
import { guardedFetch } from './guarded-fetch';
import { ssrfSafeLookup } from './ssrf';
import { DirectTransport } from './transport-direct';

/** Answer `answers`' names from a fixed table and every other name from the real resolver; returns the undo. */
function stubDns(answers: Record<string, string>): () => void {
  const realLookup = dns.lookup.bind(dns);
  const realPromise = dns.promises.lookup.bind(dns.promises);
  const record = (hostname: string) => {
    const address = answers[hostname];
    return address === undefined ? undefined : { address, family: isIP(address) };
  };
  const callback = jest.spyOn(dns, 'lookup').mockImplementation(((
    hostname: string,
    options: { all?: boolean },
    done: (err: null, address: unknown, family?: number) => void,
  ) => {
    const found = record(hostname);
    if (!found) return realLookup(hostname, options as never, done as never);
    if (options.all) return done(null, [found]);
    return done(null, found.address, found.family);
  }) as never);
  const promise = jest.spyOn(dns.promises, 'lookup').mockImplementation((async (
    hostname: string,
    options: { all?: boolean },
  ) => {
    const found = record(hostname);
    if (!found) return realPromise(hostname, options as never);
    return options.all ? [found] : found;
  }) as never);
  return () => {
    callback.mockRestore();
    promise.mockRestore();
  };
}

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

  it.each([
    ['file:///etc/passwd', 'file:'],
    ['ftp://example.com/x', 'ftp:'],
  ])(
    'refuses a redirect to %s as a scheme refusal, not as an address to allowlist',
    async (location, scheme) => {
      const to = encodeURIComponent(location);
      await withAllowedHosts('127.0.0.1', async () => {
        await expect(guardedFetch(`http://${base}/redirect?to=${to}`)).rejects.toMatchObject({
          code: 'http_error',
          message: `http://${base} redirected to a non-http(s) URL (${scheme})`,
        });
      });
      expect(server.hits).toHaveLength(1);
    },
  );

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
      if (hit.url === '/drop-after-request') {
        res.socket?.destroy();
        return;
      }
      if (hit.url === '/drop-mid-body') {
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': '100' });
        res.write('{"partial":', () => setTimeout(() => res.socket?.destroy(), 50));
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

  it('refuses a header the request cannot carry as invalid input, before anything is sent', async () => {
    await withAllowedHosts('127.0.0.1', async () => {
      await expect(
        guardedFetch(`http://${base}/x`, { headers: { expect: '100-continue' } }),
      ).rejects.toMatchObject({
        code: 'invalid_input',
        retryable: false,
        message: `the request to http://${base} could not be sent: expect header not supported`,
      });
    });
    expect(server.hits).toHaveLength(0);
  });

  it('does not resend a POST whose connection dropped once the request reached the server', async () => {
    const http = new HttpClient({ retry: { baseDelayMs: 1, maxDelayMs: 1 } });
    await withAllowedHosts('127.0.0.1', async () => {
      await expect(
        http.post(`http://${base}/drop-after-request`, {
          auth: createDirectAuth({ type: 'none' }, { type: 'none' }),
          body: { charge: 1 },
        }),
      ).rejects.toMatchObject({
        code: 'transport_interrupted',
        message: expect.stringContaining(
          `the connection to http://${base} broke possibly after the request was sent: other side closed`,
        ),
      });
    });
    expect(server.hits.map((h) => h.url)).toEqual(['/drop-after-request']);
  });

  it('says the connection broke while reading the response, naming the origin', async () => {
    const transport = new DirectTransport({ scheme: { type: 'none' }, credential: { type: 'none' } });
    await withAllowedHosts('127.0.0.1', async () => {
      await expect(
        transport.send({ method: 'GET', url: `http://${base}/drop-mid-body`, headers: {} }),
      ).rejects.toMatchObject({
        code: 'transport_interrupted',
        message: `the connection to http://${base} broke while reading the response: other side closed`,
      });
    });
  });

  it('never echoes a password from a URL that also fails to parse', async () => {
    const failure = await guardedFetch('https://admin:hunter2@exa mple.com/x').catch((err: unknown) => err);
    expect(failure).toMatchObject({
      code: 'invalid_input',
      message: 'invalid URL: "https://exa mple.com/x"',
    });
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
  let restoreDns: (() => void) | null = null;

  const proxyEnv = (extra: Record<string, string | undefined> = {}): Record<string, string | undefined> => ({
    NODE_USE_ENV_PROXY: '1',
    HTTP_PROXY: `http://localhost:${proxy.port}`,
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
    restoreDns?.();
    restoreDns = null;
    await proxy.close();
    await server.close();
  });

  it('sends a public target through a proxy named by hostname, and never judges the proxy itself', async () => {
    const res = await withEnv(proxyEnv(), () => guardedFetch('http://93.184.215.14/through'));
    expect(await res.text()).toBe('reached');
    expect(proxy.tunnels).toEqual(['93.184.215.14:80']);
    expect(server.hits.map((h) => h.url)).toEqual(['/through']);
  });

  it('tunnels to the address it judged, so a proxy that resolves names itself cannot be rebound into private space', async () => {
    const internal = await startLoopbackServer((_req, res) => res.end('INTERNAL SECRET'));
    const rebinding = await startConnectProxy((authority, index) => {
      if (isIP(authority.replace(/:\d+$/, '').replace(/^\[|\]$/g, ''))) return { port: server.port };
      return index % 2 === 0 ? { port: internal.port } : { status: 502 };
    });
    restoreDns = stubDns({ 'rebind.test': '93.184.215.14' });
    try {
      const bodies = await withEnv(
        proxyEnv({ HTTP_PROXY: `http://localhost:${rebinding.port}` }),
        async () => {
          const seen: string[] = [];
          for (let attempt = 0; attempt < 6; attempt += 1) {
            seen.push(await (await guardedFetch(`http://rebind.test/attempt-${attempt}`)).text());
          }
          return seen;
        },
      );
      expect(bodies).toEqual(Array(6).fill('reached'));
      expect(internal.hits).toHaveLength(0);
      expect(new Set(rebinding.tunnels)).toEqual(new Set(['93.184.215.14:80']));
    } finally {
      await rebinding.close();
      await internal.close();
    }
  });

  it('sends an https target through HTTPS_PROXY, tunnelled to the judged address', async () => {
    const httpsProxy = await startConnectProxy(server.port);
    restoreDns = stubDns({ 'rebind.test': '93.184.215.14' });
    try {
      await withEnv(proxyEnv({ HTTPS_PROXY: `http://localhost:${httpsProxy.port}` }), async () => {
        await expect(guardedFetch('https://rebind.test/secure')).rejects.toBeInstanceOf(Error);
      });
      expect(httpsProxy.tunnels).toEqual(['93.184.215.14:443']);
      expect(proxy.tunnels).toEqual([]);
    } finally {
      await httpsProxy.close();
    }
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

  it('refuses a proxied name this server cannot resolve, and says how to let the proxy resolve it', async () => {
    await withEnv(proxyEnv(), async () => {
      await expect(guardedFetch('http://upstream.invalid/token')).rejects.toMatchObject({
        code: 'unresolvable_host',
        message: expect.stringContaining(
          'if the egress proxy can resolve it, an operator can add upstream.invalid to ORCHESTR_HTTP_ALLOWED_HOSTS',
        ),
      });
    });
    expect(proxy.tunnels).toEqual([]);
  });

  it('sends an allowlisted name to the proxy by name, so a proxy-only resolver still works', async () => {
    const res = await withEnv(proxyEnv({ ORCHESTR_HTTP_ALLOWED_HOSTS: 'upstream.invalid' }), () =>
      guardedFetch('http://upstream.invalid/token'),
    );
    expect(await res.text()).toBe('reached');
    expect(proxy.tunnels).toEqual(['upstream.invalid:80']);
  });

  it('blames the proxy, not the target, when the proxy refuses the tunnel', async () => {
    const refusing = await startConnectProxy(() => ({ status: 407 }));
    try {
      await withEnv(proxyEnv({ HTTP_PROXY: `http://localhost:${refusing.port}` }), async () => {
        await expect(guardedFetch('http://93.184.215.14/x')).rejects.toMatchObject({
          code: 'transport_unreachable',
          retryable: false,
          message: 'the egress proxy refused the tunnel to http://93.184.215.14 (407)',
        });
      });
    } finally {
      await refusing.close();
    }
  });

  it('says the proxy is down without printing where it lives', async () => {
    const gone = await startLoopbackServer();
    const deadPort = gone.port;
    await gone.close();
    await withEnv(proxyEnv({ HTTP_PROXY: `http://localhost:${deadPort}` }), async () => {
      const failure = await guardedFetch('http://93.184.215.14/x').catch((err: unknown) => err);
      expect(failure).toMatchObject({
        code: 'transport_unreachable',
        message: 'the egress proxy could not be reached on the way to http://93.184.215.14',
      });
      expect((failure as Error).message).not.toContain(String(deadPort));
    });
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

  it.each([
    ['--use-env-proxy on the command line', { execArgv: true, nodeOptions: undefined }],
    ['--use-env-proxy in NODE_OPTIONS', { execArgv: false, nodeOptions: '--use-env-proxy' }],
  ])('honours %s', async (_label, how) => {
    const saved = [...process.execArgv];
    if (how.execArgv) process.execArgv.push('--use-env-proxy');
    try {
      await withEnv(proxyEnv({ NODE_USE_ENV_PROXY: undefined, NODE_OPTIONS: how.nodeOptions }), () =>
        guardedFetch('http://93.184.215.14/flag'),
      );
    } finally {
      process.execArgv.splice(0, process.execArgv.length, ...saved);
    }
    expect(proxy.tunnels).toEqual(['93.184.215.14:80']);
  });

  it('opens a fresh pool when only the proxy changes, so the new proxy carries the next request', async () => {
    const second = await startConnectProxy(server.port);
    try {
      await withEnv(proxyEnv(), async () => {
        await (await guardedFetch('http://93.184.215.14/first')).text();
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      await withEnv(proxyEnv({ HTTP_PROXY: `http://localhost:${second.port}` }), async () => {
        await (await guardedFetch('http://93.184.215.14/second')).text();
      });
      expect(proxy.tunnels).toEqual(['93.184.215.14:80']);
      expect(second.tunnels).toEqual(['93.184.215.14:80']);
    } finally {
      await second.close();
    }
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
