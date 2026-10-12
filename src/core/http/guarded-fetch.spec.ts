import {
  type ConnectProxy,
  type LoopbackServer,
  startConnectProxy,
  startLoopbackServer,
  withAllowedHosts,
  withEnv,
} from '../../testing/loopback-server';
import { runInPlainNode } from '../../testing/plain-node';
import dns from 'node:dns';
import { readFileSync } from 'node:fs';
import type { Server } from 'node:https';
import { createServer as createHttpsServer } from 'node:https';
import { type AddressInfo, createServer as createNetServer, isIP, type Socket } from 'node:net';
import { join } from 'node:path';
import tls from 'node:tls';
import zlib from 'node:zlib';

import { createDirectAuth } from '../auth-factories';
import { HttpClient } from './client';
import { guardedFetch } from './guarded-fetch';
import { ssrfSafeLookup } from './ssrf';
import { DirectTransport } from './transport-direct';

/** Answer `answers`' names from a fixed table and every other name from the real resolver; returns the undo. */
function stubDns(answers: Record<string, string | string[]>): () => void {
  const realLookup = dns.lookup.bind(dns);
  const realPromise = dns.promises.lookup.bind(dns.promises);
  const records = (hostname: string) => {
    const answer = answers[hostname];
    if (answer === undefined) return undefined;
    return (Array.isArray(answer) ? answer : [answer]).map((address) => ({ address, family: isIP(address) }));
  };
  const callback = jest.spyOn(dns, 'lookup').mockImplementation(((
    hostname: string,
    options: { all?: boolean },
    done: (err: null, address: unknown, family?: number) => void,
  ) => {
    const found = records(hostname);
    if (!found?.[0]) return realLookup(hostname, options as never, done as never);
    if (options.all) return done(null, found);
    return done(null, found[0].address, found[0].family);
  }) as never);
  const promise = jest.spyOn(dns.promises, 'lookup').mockImplementation((async (
    hostname: string,
    options: { all?: boolean },
  ) => {
    const found = records(hostname);
    if (!found?.[0]) return realPromise(hostname, options as never);
    return options.all ? found : found[0];
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
      if (hit.url === '/slow') {
        setTimeout(() => res.end('late'), 400);
        return;
      }
      if (hit.url === '/br-lie' || hit.url === '/zstd-lie') {
        res.writeHead(200, { 'content-encoding': hit.url === '/br-lie' ? 'br' : 'zstd' });
        res.end('this is not compressed');
        return;
      }
      if (hit.url === '/gzip-lie') {
        res.writeHead(200, { 'content-encoding': 'gzip', 'content-type': 'text/plain' });
        res.end('this is not gzip');
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

  it('refuses a port fetch will not use as invalid input', async () => {
    await withAllowedHosts('127.0.0.1', async () => {
      await expect(guardedFetch('http://127.0.0.1:9/feed.xml')).rejects.toMatchObject({
        code: 'invalid_input',
        message:
          'the request to http://127.0.0.1:9 could not be sent: fetch will not connect to port 9, a port the Fetch standard blocks',
      });
    });
  });

  it.each([
    [
      'a value with a line break',
      { 'x-api-key': 'sk_live_secret\r\nX-Injected: 1' },
      'header "x-api-key" has a line break',
    ],
    ['a value outside Latin-1', { 'x-title': 'Café — smart' }, 'header "x-title" has a line break'],
    [
      'a name that is not a token',
      { 'my header: sk_live_secret': 'x' },
      'a header name is not a valid HTTP token',
    ],
  ])('refuses %s before sending, naming the header but never its value', async (_label, headers, said) => {
    const failure = await withAllowedHosts('127.0.0.1', () =>
      guardedFetch(`http://${base}/x`, { method: 'POST', headers, body: '{}' }).catch((err: unknown) => err),
    );
    expect(failure).toMatchObject({ code: 'invalid_input', retryable: false });
    expect((failure as Error).message).toContain(said);
    expect((failure as Error).message).not.toMatch(/sk_live_secret|Café/);
    expect(server.hits).toHaveLength(0);
  });

  it('sends a value with a leading or trailing newline trimmed, as fetch does, rather than refusing it', async () => {
    const http = new HttpClient({ retry: { retries: 0 } });
    await withAllowedHosts('127.0.0.1', async () => {
      await http.get(`http://${base}/bearer`, {
        auth: createDirectAuth(
          { type: 'oauth2', origins: [`http://${base}`] },
          { type: 'bearer', token: 'tok_abcdefghij\n' },
        ),
      });
      await http.get(`http://${base}/apikey`, {
        auth: createDirectAuth(
          { type: 'apiKey', origins: [`http://${base}`], in: 'header', name: 'x-k' },
          { type: 'apiKey', value: 'sk_live_123\r\n' },
        ),
      });
      await http.get(`http://${base}/header`, {
        auth: createDirectAuth({ type: 'none' }, { type: 'none' }),
        headers: { 'x-from-step': '\nvalue\n' },
      });
    });
    expect(
      server.hits.map((h) => [h.headers.authorization, h.headers['x-k'], h.headers['x-from-step']]),
    ).toEqual([
      ['Bearer tok_abcdefghij', undefined, undefined],
      [undefined, 'sk_live_123', undefined],
      [undefined, undefined, 'value'],
    ]);
  });

  it('sends a non-string header value as its string form, as fetch does', async () => {
    const headers = { 'x-page': 2, 'x-flag': true } as unknown as Record<string, string>;
    await withAllowedHosts('127.0.0.1', () =>
      guardedFetch(`http://${base}/n`, { headers }).then((res) => res.text()),
    );
    expect(server.hits[0]?.headers).toMatchObject({ 'x-page': '2', 'x-flag': 'true' });
  });

  it('drops a pasted Content-Length, so the request is framed by fetch instead of hanging', async () => {
    await withAllowedHosts('127.0.0.1', () =>
      guardedFetch(`http://${base}/framed`, {
        method: 'POST',
        headers: { 'content-length': '5', 'content-type': 'application/json' },
        body: '{"hello":"world"}',
      }).then((res) => res.text()),
    );
    expect(server.hits[0]).toMatchObject({ body: '{"hello":"world"}', headers: { 'content-length': '17' } });
  });

  it('refuses a body on a GET with a reason, before sending', async () => {
    await withAllowedHosts('127.0.0.1', async () => {
      await expect(
        guardedFetch(`http://${base}/x`, { method: 'GET', body: '{"q":1}' }),
      ).rejects.toMatchObject({
        code: 'invalid_input',
        message: `the request to http://${base} could not be sent: a GET request cannot carry a body`,
      });
    });
    expect(server.hits).toHaveLength(0);
  });

  it("keeps fetch's own reason when it refuses a request it was given", async () => {
    await withAllowedHosts('127.0.0.1', async () => {
      await expect(guardedFetch(`http://${base}/x`, { method: 'GE T' })).rejects.toMatchObject({
        code: 'invalid_input',
        message: expect.stringContaining('GE T'),
      });
    });
  });

  it('retries a POST whose TLS handshake was cut short, since nothing was sent', async () => {
    let handshakes = 0;
    const dropper = createNetServer((socket) => {
      socket.once('data', () => {
        handshakes += 1;
        socket.end();
      });
    });
    await new Promise<void>((resolve) => dropper.listen(0, '127.0.0.1', resolve));
    const { port } = dropper.address() as AddressInfo;
    const http = new HttpClient({ retry: { baseDelayMs: 1, maxDelayMs: 1 } });
    try {
      await withAllowedHosts('127.0.0.1', async () => {
        await expect(
          http.post(`https://127.0.0.1:${port}/charge`, {
            auth: createDirectAuth({ type: 'none' }, { type: 'none' }),
            body: { amount: 5 },
          }),
        ).rejects.toMatchObject({
          code: 'transport_unreachable',
          message: expect.stringContaining(`could not reach https://127.0.0.1:${port}:`),
        });
      });
      expect(handshakes).toBe(4);
    } finally {
      await new Promise((resolve) => dropper.close(resolve));
    }
  });

  it.each([
    '/br-lie',
    ...(typeof (zlib as { createZstdDecompress?: unknown }).createZstdDecompress === 'function'
      ? ['/zstd-lie']
      : []),
  ])('calls a %s body that will not decode a provider error and fetches it once', async (path) => {
    const http = new HttpClient({ retry: { baseDelayMs: 1, maxDelayMs: 1 } });
    await withAllowedHosts('127.0.0.1', async () => {
      await expect(
        http.get(`http://${base}${path}`, { auth: createDirectAuth({ type: 'none' }, { type: 'none' }) }),
      ).rejects.toMatchObject({ code: 'provider_error', retryable: false });
    });
    expect(server.hits).toHaveLength(1);
  });

  it('does not resend a POST that timed out, since it may already have arrived', async () => {
    const http = new HttpClient({ retry: { baseDelayMs: 1, maxDelayMs: 1 } });
    await withAllowedHosts('127.0.0.1', async () => {
      await expect(
        http.post(`http://${base}/slow`, {
          auth: createDirectAuth({ type: 'none' }, { type: 'none' }),
          body: { amount: 5 },
          timeoutMs: 100,
        }),
      ).rejects.toMatchObject({ code: 'transport_timeout' });
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(server.hits.map((h) => h.url)).toEqual(['/slow']);
  });

  it('says a server that speaks first was not answering with HTTP, and does not retry it', async () => {
    const sockets: Socket[] = [];
    const banner = createNetServer((socket) => {
      sockets.push(socket);
      socket.write('SSH-2.0-OpenSSH_9.6\r\n');
    });
    await new Promise<void>((resolve) => banner.listen(0, '127.0.0.1', resolve));
    const { port } = banner.address() as AddressInfo;
    try {
      await withAllowedHosts('127.0.0.1', async () => {
        await expect(guardedFetch(`http://127.0.0.1:${port}/`)).rejects.toMatchObject({
          code: 'http_error',
          retryable: false,
          message: expect.stringContaining(`http://127.0.0.1:${port} did not answer with HTTP`),
        });
      });
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => banner.close(resolve));
    }
  });

  it('calls a body that will not decode a provider error and fetches it once', async () => {
    const http = new HttpClient({ retry: { baseDelayMs: 1, maxDelayMs: 1 } });
    await withAllowedHosts('127.0.0.1', async () => {
      await expect(
        http.get(`http://${base}/gzip-lie`, { auth: createDirectAuth({ type: 'none' }, { type: 'none' }) }),
      ).rejects.toMatchObject({
        code: 'provider_error',
        retryable: false,
        message: expect.stringContaining(`http://${base} sent a response body that could not be decoded`),
      });
    });
    expect(server.hits.map((h) => h.url)).toEqual(['/gzip-lie']);
  });

  it('names the hop whose body broke, not the origin that redirected to it', async () => {
    const second = await startLoopbackServer((_req, res) => {
      res.writeHead(200, { 'content-length': '100' });
      res.write('partial', () => setTimeout(() => res.socket?.destroy(), 50));
    });
    const relay = await startLoopbackServer((_req, res) => {
      res.writeHead(302, { location: `http://localhost:${second.port}/drop` });
      res.end();
    });
    const transport = new DirectTransport({ scheme: { type: 'none' }, credential: { type: 'none' } });
    try {
      await withAllowedHosts('127.0.0.1,localhost', async () => {
        await expect(
          transport.send({ method: 'GET', url: `http://127.0.0.1:${relay.port}/`, headers: {} }),
        ).rejects.toMatchObject({
          code: 'transport_interrupted',
          message: `the connection to http://localhost:${second.port} broke while reading the response: other side closed`,
        });
      });
    } finally {
      await relay.close();
      await second.close();
    }
  });

  it('keeps the reason for a dual-stack refusal on the real error path, outside Jest', async () => {
    const closed = await startLoopbackServer();
    const { port } = closed;
    await closed.close();
    const out = await runInPlainNode(
      `require(${JSON.stringify(join(__dirname, 'guarded-fetch.ts'))})
        .guardedFetch('http://localhost:${port}/x')
        .catch((err) => console.log(JSON.stringify({ code: err.code, message: err.message })));`,
      { ORCHESTR_HTTP_ALLOWED_HOSTS: 'localhost' },
    );
    expect(JSON.parse(out)).toEqual({
      code: 'transport_unreachable',
      message: expect.stringMatching(
        new RegExp(`^could not reach http://localhost:${port}: connect ECONNREFUSED`),
      ),
    });
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

  it.each([
    ['https://admin:hunter2@exa mple.com/x', 'https://exa mple.com/x'],
    ['https://admin:p@ssw0rd@exa mple.com/x', 'https://exa mple.com/x'],
    ['https://admin:hunter#2@api.example.com/v1', 'https://api.example.com/v1'],
    ['https://admin:what?now@api.example.com/v1', 'https://api.example.com/v1'],
    ['https://admin:a/b@api.example.com/v1', 'https://api.example.com/v1'],
  ])('never echoes a password from %s, which also fails to parse', async (url, shown) => {
    const failure = await guardedFetch(url).catch((err: unknown) => err);
    expect(failure).toMatchObject({ code: 'invalid_input', message: `invalid URL: "${shown}"` });
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

  it('tunnels a dual-stack name to its IPv4 address, which an egress proxy is far likelier to reach', async () => {
    restoreDns = stubDns({ 'dual.test': ['2606:4700:4700::1111', '93.184.215.14'] });
    await withEnv(proxyEnv(), () => guardedFetch('http://dual.test/x'));
    expect(proxy.tunnels).toEqual(['93.184.215.14:80']);
  });

  it('moves on to the next judged address when the proxy cannot reach the first (502)', async () => {
    const picky = await startConnectProxy((authority) =>
      authority.startsWith('93.184.215.14:') ? { status: 502 } : { port: server.port },
    );
    restoreDns = stubDns({ 'multi.test': ['2606:4700:4700::1111', '93.184.215.14', '93.184.215.15'] });
    try {
      const res = await withEnv(proxyEnv({ HTTP_PROXY: `http://localhost:${picky.port}` }), () =>
        guardedFetch('http://multi.test/x'),
      );
      expect(await res.text()).toBe('reached');
      expect(picky.tunnels).toEqual(['93.184.215.14:80', '93.184.215.15:80']);
    } finally {
      await picky.close();
    }
  });

  it('does not try other addresses when the proxy refuses on policy (407)', async () => {
    const refusing = await startConnectProxy(() => ({ status: 407 }));
    restoreDns = stubDns({ 'multi.test': ['93.184.215.14', '93.184.215.15'] });
    try {
      await withEnv(proxyEnv({ HTTP_PROXY: `http://localhost:${refusing.port}` }), async () => {
        await expect(guardedFetch('http://multi.test/x')).rejects.toMatchObject({
          message: 'the egress proxy refused the tunnel to http://multi.test (407)',
        });
      });
      expect(refusing.tunnels).toEqual(['93.184.215.14:80']);
    } finally {
      await refusing.close();
    }
  });

  it('gives up on a proxy that never answers the tunnel request, well inside a request budget', async () => {
    const hung = await startConnectProxy(() => ({ hang: true }));
    const started = Date.now();
    try {
      await withEnv(proxyEnv({ HTTP_PROXY: `http://localhost:${hung.port}` }), async () => {
        await expect(guardedFetch('http://93.184.215.14/x')).rejects.toMatchObject({
          code: 'transport_unreachable',
          message: 'the egress proxy did not answer the tunnel request on the way to http://93.184.215.14',
        });
      });
      expect(Date.now() - started).toBeLessThan(15_000);
    } finally {
      await hung.close();
    }
  }, 20_000);

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

  it('sends the proxy URL credentials as Proxy-Authorization, and never to the target', async () => {
    const expected = `Basic ${Buffer.from('u:p@ss w').toString('base64')}`;
    const guarded = await startConnectProxy((_authority, _index, headers) =>
      headers['proxy-authorization'] === expected ? { port: server.port } : { status: 407 },
    );
    try {
      const res = await withEnv(
        proxyEnv({ HTTP_PROXY: `http://u:p%40ss%20w@localhost:${guarded.port}` }),
        () => guardedFetch('http://93.184.215.14/authed'),
      );
      expect(await res.text()).toBe('reached');
      expect(server.hits[0]?.headers['proxy-authorization']).toBeUndefined();
      await withEnv(proxyEnv({ HTTP_PROXY: `http://localhost:${guarded.port}` }), async () => {
        await expect(guardedFetch('http://93.184.215.14/anonymous')).rejects.toMatchObject({
          message: 'the egress proxy refused the tunnel to http://93.184.215.14 (407)',
          retryable: false,
        });
      });
      expect(guarded.headers.map((h) => h['proxy-authorization'])).toEqual([expected, undefined]);
    } finally {
      await guarded.close();
    }
  });

  it('calls an oversized tunnel reply invalid instead of blaming reachability', async () => {
    const babbling = await startConnectProxy(() => ({
      reply: `HTTP/1.1 200 OK\r\nX-Pad: ${'a'.repeat(70_000)}\r\n\r\n`,
    }));
    try {
      await withEnv(proxyEnv({ HTTP_PROXY: `http://localhost:${babbling.port}` }), async () => {
        await expect(guardedFetch('http://93.184.215.14/x')).rejects.toMatchObject({
          retryable: false,
          message: 'the egress proxy sent an invalid reply on the way to http://93.184.215.14',
        });
      });
    } finally {
      await babbling.close();
    }
  });

  it('fails once, without a reconnect loop, when data arrives with the tunnel before the request', async () => {
    const chatty = await startConnectProxy(() => ({
      port: server.port,
      preface: 'HTTP/1.1 200 OK\r\n\r\nINJECTED',
    }));
    try {
      await withEnv(proxyEnv({ HTTP_PROXY: `http://localhost:${chatty.port}` }), async () => {
        await expect(guardedFetch('http://93.184.215.14/x')).rejects.toMatchObject({
          code: 'http_error',
          retryable: false,
          message:
            'the tunnel to http://93.184.215.14 carried data before the request was sent, so it is not answering as an HTTP server',
        });
      });
      expect(chatty.tunnels).toHaveLength(1);
    } finally {
      await chatty.close();
    }
  });

  it.each([
    ['localhost:3128', 'HTTP_PROXY is not a valid proxy URL: it must start with http:// or https://'],
    [
      'socks5://127.0.0.1:1080',
      'HTTP_PROXY names a SOCKS proxy, which is not supported; use an HTTP or HTTPS proxy',
    ],
    ['http://u:p%zz@localhost:3128', 'HTTP_PROXY has credentials that are not valid percent-encoding'],
  ])('refuses HTTP_PROXY=%s by naming the variable', async (raw, message) => {
    await withEnv(proxyEnv({ HTTP_PROXY: raw }), async () => {
      await expect(guardedFetch('http://93.184.215.14/x')).rejects.toMatchObject({
        code: 'invalid_input',
        retryable: false,
        message,
      });
    });
  });

  it('keeps working once a briefly invalid proxy setting is put back', async () => {
    await withEnv(proxyEnv(), () => guardedFetch('http://93.184.215.14/one').then((res) => res.text()));
    await withEnv(proxyEnv({ HTTP_PROXY: 'http://[bad' }), async () => {
      await expect(guardedFetch('http://93.184.215.14/x')).rejects.toMatchObject({ code: 'invalid_input' });
    });
    const res = await withEnv(proxyEnv(), () => guardedFetch('http://93.184.215.14/two'));
    expect(await res.text()).toBe('reached');
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

describe('guardedFetch — TLS to the proxy and over the tunnel', () => {
  const fixture = (name: string): string =>
    readFileSync(join(__dirname, '../../testing/fixtures', name), 'utf8');
  const tlsFixture = { key: fixture('test-only-tls.key.pem'), cert: fixture('test-only-tls.cert.pem') };
  const defaultCAs = tls.getCACertificates('default');
  let secure: Server;
  let securePort: number;
  let plain: LoopbackServer;
  let restoreDns: () => void;
  const serverNames: Array<string | false> = [];

  const env = (proxy: Record<string, string>): Record<string, string | undefined> => ({
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

  beforeAll(async () => {
    tls.setDefaultCACertificates([...defaultCAs, tlsFixture.cert]);
    secure = createHttpsServer(tlsFixture, (req, res) => res.end(`secure ${req.url}`));
    secure.on('secureConnection', (socket) =>
      serverNames.push((socket as { servername?: string | false }).servername ?? false),
    );
    await new Promise<void>((resolve) => secure.listen(0, '127.0.0.1', resolve));
    securePort = (secure.address() as AddressInfo).port;
    plain = await startLoopbackServer();
    restoreDns = stubDns({
      'secure.test': '93.184.215.14',
      'other.test': '93.184.215.14',
      'proxy.test': '127.0.0.1',
    });
  });

  afterAll(async () => {
    restoreDns();
    tls.setDefaultCACertificates(defaultCAs);
    secure.closeAllConnections();
    await new Promise<void>((resolve) => secure.close(() => resolve()));
    await plain.close();
  });

  it('opens the tunnel inside TLS to an https:// proxy', async () => {
    const proxy = await startConnectProxy(plain.port, { tls: tlsFixture });
    try {
      const res = await withEnv(env({ HTTP_PROXY: `https://localhost:${proxy.port}` }), () =>
        guardedFetch('http://93.184.215.14/plain'),
      );
      expect(await res.text()).toBe('reached');
      expect(proxy.tunnels).toEqual(['93.184.215.14:80']);
    } finally {
      await proxy.close();
    }
  });

  it('verifies the target certificate against the hostname over a tunnel opened to its address', async () => {
    const proxy = await startConnectProxy(securePort);
    try {
      const res = await withEnv(env({ HTTPS_PROXY: `http://localhost:${proxy.port}` }), () =>
        guardedFetch('https://secure.test/x'),
      );
      expect(await res.text()).toBe('secure /x');
      expect(proxy.tunnels).toEqual(['93.184.215.14:443']);
    } finally {
      await proxy.close();
    }
  });

  it('refuses a target whose certificate does not name it, though the tunnel reached the same address', async () => {
    const proxy = await startConnectProxy(securePort);
    try {
      await withEnv(env({ HTTPS_PROXY: `http://localhost:${proxy.port}` }), async () => {
        await expect(guardedFetch('https://other.test/x')).rejects.toMatchObject({
          code: 'transport_unreachable',
          retryable: false,
          message: expect.stringContaining(
            "could not reach https://other.test: Hostname/IP does not match certificate's altnames",
          ),
        });
      });
    } finally {
      await proxy.close();
    }
  });

  it('verifies an https:// proxy addressed by IP against its IP, also when it carries an allowlisted name', async () => {
    const proxy = await startConnectProxy(plain.port, { tls: tlsFixture });
    try {
      const res = await withEnv(
        env({
          HTTP_PROXY: `https://127.0.0.1:${proxy.port}`,
          ORCHESTR_HTTP_ALLOWED_HOSTS: 'upstream.invalid',
        }),
        () => guardedFetch('http://upstream.invalid/by-ip-proxy'),
      );
      expect(await res.text()).toBe('reached');
      expect(proxy.tunnels).toEqual(['upstream.invalid:80']);
    } finally {
      await proxy.close();
    }
  });

  it('says to check the scheme when TLS to the proxy fails for a reason other than its certificate', async () => {
    const plainProxy = await startConnectProxy(plain.port);
    try {
      await withEnv(env({ HTTP_PROXY: `https://localhost:${plainProxy.port}` }), async () => {
        await expect(guardedFetch('http://93.184.215.14/x')).rejects.toMatchObject({
          retryable: false,
          message: expect.stringMatching(
            /^TLS to the egress proxy failed \(ERR_SSL_[A-Z_]+\); check whether the proxy URL should be http:\/\/ or https:\/\//,
          ),
        });
      });
    } finally {
      await plainProxy.close();
    }
  });

  it('says a proxy that closed on a plaintext CONNECT may want https://', async () => {
    const tlsProxy = await startConnectProxy(plain.port, { tls: tlsFixture });
    try {
      await withEnv(env({ HTTP_PROXY: `http://localhost:${tlsProxy.port}` }), async () => {
        await expect(guardedFetch('http://93.184.215.14/x')).rejects.toMatchObject({
          message:
            'the egress proxy closed the connection without answering; if it speaks TLS, the proxy URL should be https:// on the way to http://93.184.215.14',
        });
      });
    } finally {
      await tlsProxy.close();
    }
  });

  it('verifies an https:// proxy against its own name, also when it carries an allowlisted name', async () => {
    const proxy = await startConnectProxy(plain.port, { tls: tlsFixture });
    try {
      const res = await withEnv(
        env({
          HTTP_PROXY: `https://localhost:${proxy.port}`,
          ORCHESTR_HTTP_ALLOWED_HOSTS: 'upstream.invalid',
        }),
        () => guardedFetch('http://upstream.invalid/allowlisted'),
      );
      expect(await res.text()).toBe('reached');
      expect(proxy.tunnels).toEqual(['upstream.invalid:80']);
    } finally {
      await proxy.close();
    }
  });

  it('reaches an https IP literal through the proxy without sending the IP as the TLS server name', async () => {
    const proxy = await startConnectProxy(securePort);
    try {
      const res = await withEnv(
        env({ HTTPS_PROXY: `http://localhost:${proxy.port}`, ORCHESTR_HTTP_ALLOWED_HOSTS: '127.0.0.1' }),
        () => guardedFetch(`https://127.0.0.1:${securePort}/ip`),
      );
      expect(await res.text()).toBe('secure /ip');
      expect(serverNames.at(-1)).toBe(false);
    } finally {
      await proxy.close();
    }
  });

  it("says the proxy's certificate was rejected, without naming the proxy", async () => {
    const proxy = await startConnectProxy(plain.port, { tls: tlsFixture });
    try {
      await withEnv(env({ HTTP_PROXY: `https://proxy.test:${proxy.port}` }), async () => {
        const failure = await guardedFetch('http://93.184.215.14/x').catch((err: unknown) => err);
        expect(failure).toMatchObject({
          retryable: false,
          message:
            "the egress proxy's certificate was rejected (ERR_TLS_CERT_ALTNAME_INVALID) on the way to http://93.184.215.14",
        });
        expect((failure as Error).message).not.toContain('proxy.test');
      });
    } finally {
      await proxy.close();
    }
  });

  it('calls a tunnel that closes during the target TLS handshake never sent', async () => {
    const proxy = await startConnectProxy(() => ({ reply: 'HTTP/1.1 200 Connection Established\r\n\r\n' }));
    try {
      await withEnv(env({ HTTPS_PROXY: `http://localhost:${proxy.port}` }), async () => {
        await expect(
          guardedFetch('https://secure.test/x', { method: 'POST', body: '{}' }),
        ).rejects.toMatchObject({
          code: 'transport_unreachable',
          message: expect.stringContaining('could not reach https://secure.test:'),
        });
      });
    } finally {
      await proxy.close();
    }
  });

  it('runs TLS to the target inside TLS to the proxy', async () => {
    const proxy = await startConnectProxy(securePort, { tls: tlsFixture });
    try {
      const res = await withEnv(env({ HTTPS_PROXY: `https://localhost:${proxy.port}` }), () =>
        guardedFetch('https://secure.test/nested'),
      );
      expect(await res.text()).toBe('secure /nested');
      expect(proxy.tunnels).toEqual(['93.184.215.14:443']);
    } finally {
      await proxy.close();
    }
  });
});
