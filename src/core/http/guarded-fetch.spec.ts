import { type LoopbackServer, startLoopbackServer, withAllowedHosts } from '../../testing/loopback-server';
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
    await expect(guardedFetch('http://does-not-exist.invalid/')).rejects.toThrow();
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
