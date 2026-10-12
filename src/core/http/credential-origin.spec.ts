import { inspect } from 'node:util';

import type { AuthScheme, CredentialOrigins, CustomScheme, DirectCredential, NoneScheme } from '../auth';
import { createDirectAuth } from '../auth-factories';
import {
  type LoopbackHit,
  type LoopbackServer,
  startLoopbackServer,
  withAllowedHosts,
} from '../../testing/loopback-server';
import { ActionError } from '../errors';
import { HttpClient } from './client';
import { guardedFetch } from './guarded-fetch';
import { DirectTransport } from './transport-direct';
import type { JsonValue } from './types';
import { paginate } from './pagination';

type Unscoped<T> = T extends unknown ? Omit<T, 'origins'> : never;
type Carrier = {
  scheme: Unscoped<Exclude<AuthScheme, NoneScheme>>;
  credential: DirectCredential;
  read: (hit: LoopbackHit) => unknown;
  echoed?: string;
};

const SECRET = 'S3CRET';
const BASIC_SECRET = Buffer.from(`me:${SECRET}`).toString('base64');
const CARRIERS: Record<string, Carrier> = {
  'an apiKey header': {
    scheme: { type: 'apiKey', in: 'header', name: 'X-Api-Key' },
    credential: { type: 'apiKey', value: SECRET },
    read: (hit) => hit.headers['x-api-key'],
  },
  'a bearer token': {
    scheme: { type: 'oauth2' },
    credential: { type: 'bearer', token: SECRET },
    read: (hit) => hit.headers.authorization,
  },
  'HTTP Basic': {
    scheme: { type: 'basic' },
    credential: { type: 'basic', username: 'me', password: SECRET },
    read: (hit) =>
      hit.headers.authorization === undefined
        ? undefined
        : Buffer.from(String(hit.headers.authorization).replace(/^Basic /, ''), 'base64').toString(),
  },
  'a custom-scheme signature header': {
    scheme: {
      type: 'custom',
      apply: (req, cred) => {
        if (cred.type === 'apiKey') req.headers['X-Signature'] = cred.value;
      },
    },
    credential: { type: 'apiKey', value: SECRET },
    read: (hit) => hit.headers['x-signature'],
  },
  'an apiKey query param': {
    scheme: { type: 'apiKey', in: 'query', name: 'key' },
    credential: { type: 'apiKey', value: SECRET },
    read: (hit) => new URL(hit.url, 'http://x').searchParams.get('key') ?? undefined,
    echoed: `&key=${SECRET}`,
  },
};

/** LIVE on loopback: a provider and a foreign server on real sockets; the foreign one must never see the credential. */
describe('a credential never reaches a foreign origin — real sockets', () => {
  const http = new HttpClient({ retry: { retries: 0 } });
  let provider: LoopbackServer;
  let foreign: LoopbackServer;
  let providerOrigin: string;
  let lateHeaders: Record<string, string> | undefined;
  let foreignOrigin: string;

  beforeEach(async () => {
    provider = await startLoopbackServer((_req, res, hit) => {
      const url = new URL(hit.url, 'http://x');
      const to = url.searchParams.get('to');
      if (url.pathname === '/redirect' && to) {
        res.writeHead(Number(url.searchParams.get('status')), { location: to });
        res.end();
        return;
      }
      if (url.pathname === '/mutate') {
        if (lateHeaders) lateHeaders['x-late'] = SECRET;
        res.writeHead(307, { location: '/after' });
        res.end();
        return;
      }
      if (url.pathname === '/flaky' && to) {
        const first = provider.hits.filter((h) => h.url.startsWith('/flaky')).length === 1;
        res.writeHead(first ? 503 : 307, first ? {} : { location: to });
        res.end();
        return;
      }
      if (url.pathname === '/items') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ items: [hit.url], next: url.searchParams.get('next') }));
        return;
      }
      res.end('provider');
    });
    foreign = await startLoopbackServer((_req, res) => res.end('foreign'));
    providerOrigin = `http://127.0.0.1:${provider.port}`;
    foreignOrigin = `http://127.0.0.1:${foreign.port}`;
  });

  afterEach(async () => {
    await provider.close();
    await foreign.close();
  });

  const authFor = (carrier: Carrier) =>
    createDirectAuth({ ...carrier.scheme, origins: [providerOrigin] }, carrier.credential);
  const redirectUrl = (to: string, status: number) =>
    `${providerOrigin}/redirect?status=${status}&to=${encodeURIComponent(to)}`;

  describe.each(Object.entries(CARRIERS))('%s', (_label, carrier) => {
    it.each([301, 302, 303, 307, 308])(
      'is not carried across a %i redirect to another origin',
      async (status) => {
        const res = await withAllowedHosts('127.0.0.1', () =>
          http.get(redirectUrl(`${foreignOrigin}/landing?keep=1${carrier.echoed ?? ''}`, status), {
            auth: authFor(carrier),
          }),
        );
        expect(res.data).toBe('foreign');
        expect(carrier.read(provider.hits[0]!)).toContain(SECRET);
        expect(foreign.hits).toHaveLength(1);
        expect(carrier.read(foreign.hits[0]!)).toBeUndefined();
        expect(JSON.stringify(foreign.hits[0])).not.toMatch(new RegExp(`${SECRET}|${BASIC_SECRET}`));
        expect(foreign.hits[0]!.url).toContain('keep=1');
      },
    );

    it('is refused for a request aimed at another origin, which is never dialled', async () => {
      await expect(
        withAllowedHosts('127.0.0.1', () => http.get(`${foreignOrigin}/steal`, { auth: authFor(carrier) })),
      ).rejects.toMatchObject({ code: 'credential_scope' });
      expect(foreign.hits).toHaveLength(0);
    });

    it('still reaches its own origin', async () => {
      const res = await withAllowedHosts('127.0.0.1', () =>
        http.get(`${providerOrigin}/ok`, { auth: authFor(carrier) }),
      );
      expect(res.data).toBe('provider');
      expect(carrier.read(provider.hits[0]!)).toContain(SECRET);
    });
  });

  it('keeps the credential on a same-origin redirect', async () => {
    const carrier = CARRIERS['an apiKey header']!;
    await withAllowedHosts('127.0.0.1', () =>
      http.get(redirectUrl(`${providerOrigin}/moved`, 301), { auth: authFor(carrier) }),
    );
    expect(provider.hits.map((h) => [new URL(h.url, 'http://x').pathname, carrier.read(h)])).toEqual([
      ['/redirect', SECRET],
      ['/moved', SECRET],
    ]);
  });

  it('does not re-attach the credential when a redirect chain returns to the origin', async () => {
    const carrier = CARRIERS['an apiKey header']!;
    const bouncer = await startLoopbackServer((_req, res) => {
      res.writeHead(302, { location: `${providerOrigin}/home` });
      res.end();
    });
    try {
      await withAllowedHosts('127.0.0.1', () =>
        http.get(redirectUrl(`http://127.0.0.1:${bouncer.port}/bounce`, 302), { auth: authFor(carrier) }),
      );
      expect(carrier.read(bouncer.hits[0]!)).toBeUndefined();
      expect(provider.hits.map((h) => carrier.read(h))).toEqual([SECRET, undefined]);
    } finally {
      await bouncer.close();
    }
  });

  it('refuses a provider-supplied next page on another origin before dialling it', async () => {
    const carrier = CARRIERS['HTTP Basic']!;
    await expect(
      withAllowedHosts('127.0.0.1', () =>
        paginate({
          http,
          auth: authFor(carrier),
          url: `${providerOrigin}/items?next=${encodeURIComponent(`${foreignOrigin}/items`)}`,
          extractItems: (res) => (res.data as { items: unknown[] }).items,
          nextPage: (res) => (res.data as { next: string | null }).next,
        }),
      ),
    ).rejects.toMatchObject({ code: 'credential_scope' });
    expect(provider.hits).toHaveLength(1);
    expect(foreign.hits).toHaveLength(0);
  });

  it('follows a same-origin next page with the credential', async () => {
    const carrier = CARRIERS['HTTP Basic']!;
    const items = await withAllowedHosts('127.0.0.1', () =>
      paginate({
        http,
        auth: authFor(carrier),
        url: `${providerOrigin}/items?next=${encodeURIComponent(`${providerOrigin}/items`)}`,
        extractItems: (res) => (res.data as { items: unknown[] }).items,
        nextPage: (res) => (res.data as { next: string | null }).next,
      }),
    );
    expect(items).toHaveLength(2);
    expect(provider.hits.map((h) => carrier.read(h))).toEqual([`me:${SECRET}`, `me:${SECRET}`]);
  });

  it('checks the URL a custom scheme actually sends, not the one it was handed', async () => {
    const auth = createDirectAuth(
      {
        type: 'custom',
        origins: [providerOrigin],
        apply: (req, cred) => {
          req.url = req.url.replace(providerOrigin, foreignOrigin);
          if (cred.type === 'apiKey') req.headers['x-signature'] = cred.value;
        },
      },
      { type: 'apiKey', value: SECRET },
    );
    await expect(
      withAllowedHosts('127.0.0.1', () => http.get(`${providerOrigin}/x`, { auth })),
    ).rejects.toMatchObject({ code: 'credential_scope' });
    expect(provider.hits).toHaveLength(0);
    expect(foreign.hits).toHaveLength(0);
  });

  it('scopes a custom scheme even with no credential, since apply can still attach a secret it holds', async () => {
    const auth = createDirectAuth(
      {
        type: 'custom',
        origins: [providerOrigin],
        apply: (req) => {
          req.headers['x-signature'] = SECRET;
        },
      },
      { type: 'none' },
    );
    await expect(
      withAllowedHosts('127.0.0.1', () => http.get(`${foreignOrigin}/steal`, { auth })),
    ).rejects.toMatchObject({ code: 'credential_scope' });
    expect(foreign.hits).toHaveLength(0);
  });

  it.each([301, 302, 307, 308])(
    'replays a body a header-signing custom scheme left untouched on a %i to another origin, without the signature',
    async (status) => {
      const auth = createDirectAuth(
        {
          type: 'custom',
          origins: [providerOrigin],
          apply: (req, cred) => {
            if (cred.type === 'apiKey') req.headers['x-signature'] = cred.value;
          },
        },
        { type: 'apiKey', value: SECRET },
      );
      const res = await withAllowedHosts('127.0.0.1', () =>
        http.put(redirectUrl(`${foreignOrigin}/landing`, status), { auth, body: { a: 1 } }),
      );
      expect(res.data).toBe('foreign');
      expect(foreign.hits.map((h) => [h.method, h.body, h.headers['x-signature']])).toEqual([
        ['PUT', '{"a":1}', undefined],
      ]);
    },
  );

  it('treats a body a custom scheme changed in place as credential-bearing', async () => {
    const auth = createDirectAuth(
      {
        type: 'custom',
        origins: [providerOrigin],
        apply: (req, cred) => {
          if (cred.type === 'apiKey') (req.body as Record<string, unknown>).api_key = cred.value;
        },
      },
      { type: 'apiKey', value: SECRET },
    );
    await expect(
      withAllowedHosts('127.0.0.1', () =>
        http.put(redirectUrl(`${foreignOrigin}/landing`, 307), { auth, body: { a: 1 } }),
      ),
    ).rejects.toMatchObject({ code: 'credential_scope' });
    expect(foreign.hits).toHaveLength(0);
  });

  describe('a custom scheme sends the body as JSON.stringify of the original', () => {
    class Money {
      constructor(private readonly cents: number) {}
      toJSON(): string {
        return (this.cents / 100).toFixed(2);
      }
    }
    const headerOnly = () =>
      createDirectAuth(
        {
          type: 'custom',
          origins: [providerOrigin],
          apply: (req, cred) => {
            if (cred.type === 'apiKey') req.headers['x-signature'] = cred.value;
          },
        },
        { type: 'apiKey', value: SECRET },
      );
    const BODIES: Array<[string, unknown]> = [
      ['a prototype toJSON leaf', { amount: new Money(1999), currency: 'usd' }],
      ['a Buffer leaf', { raw: Buffer.from('hi') }],
      ['a URL leaf', { callback: new URL('https://example.com/cb') }],
    ];

    it.each(BODIES)('%s reaches the provider as JSON.stringify of the original', async (_label, body) => {
      await withAllowedHosts('127.0.0.1', () =>
        http.post(`${providerOrigin}/ok`, { auth: headerOnly(), body: body as JsonValue }),
      );
      expect(provider.hits.map((h) => h.body)).toEqual([JSON.stringify(body)]);
    });

    it.each(BODIES)(
      '%s follows a 307 to another origin, since the scheme never changed it',
      async (_label, body) => {
        const res = await withAllowedHosts('127.0.0.1', () =>
          http.post(redirectUrl(`${foreignOrigin}/landing`, 307), {
            auth: headerOnly(),
            body: body as JsonValue,
          }),
        );
        expect(res.data).toBe('foreign');
        expect(foreign.hits.map((h) => [h.body, h.headers['x-signature']])).toEqual([
          [JSON.stringify(body), undefined],
        ]);
      },
    );

    it('catches a same-length in-place edit of a file part, and leaves the caller its own bytes', async () => {
      const data = Buffer.from('{"token":"XXXXXX"}');
      const auth = createDirectAuth(
        {
          type: 'custom',
          origins: [providerOrigin],
          apply: (req, cred) => {
            const parts = (req.body as unknown as { parts: Array<{ type: string; data?: Buffer }> }).parts;
            const file = parts.find((p) => p.type === 'file')!.data!;
            if (cred.type === 'apiKey') file.write(cred.value, file.indexOf('XXXXXX'));
          },
        },
        { type: 'apiKey', value: SECRET },
      );
      await expect(
        withAllowedHosts('127.0.0.1', () =>
          http.post(redirectUrl(`${foreignOrigin}/landing`, 307), {
            auth,
            multipart: { files: { meta: { filename: 'meta.json', data, mimeType: 'application/json' } } },
          }),
        ),
      ).rejects.toMatchObject({ code: 'credential_scope' });
      expect(foreign.hits).toHaveLength(0);
      expect(data.toString()).toBe('{"token":"XXXXXX"}');
    });
  });

  const asyncSigner = (origins: CredentialOrigins) =>
    createDirectAuth(
      {
        type: 'custom',
        origins,
        apply: async (req, cred) => {
          const sig = await Promise.resolve(`sig-${cred.type === 'apiKey' ? cred.value : ''}`);
          req.headers['x-signature'] = sig;
        },
      },
      { type: 'apiKey', value: SECRET },
    );

  it('awaits an async apply, so its signature reaches the provider', async () => {
    await withAllowedHosts('127.0.0.1', () =>
      http.get(`${providerOrigin}/ok`, { auth: asyncSigner([providerOrigin]) }),
    );
    expect(provider.hits.map((h) => h.headers['x-signature'])).toEqual([`sig-${SECRET}`]);
  });

  it('never carries an async signature across a redirect to another origin', async () => {
    const res = await withAllowedHosts('127.0.0.1', () =>
      http.post(redirectUrl(`${foreignOrigin}/landing`, 307), {
        auth: asyncSigner([providerOrigin]),
        body: { a: 1 },
      }),
    );
    expect(res.data).toBe('foreign');
    expect(provider.hits.map((h) => h.headers['x-signature'])).toEqual([`sig-${SECRET}`]);
    expect(foreign.hits.map((h) => h.headers['x-signature'])).toEqual([undefined]);
  });

  const failingApply = (apply: CustomScheme['apply']) =>
    createDirectAuth({ type: 'custom', origins: [providerOrigin], apply }, { type: 'apiKey', value: SECRET });

  it.each([
    [
      'a sync throw',
      () => {
        throw new Error('signing key unavailable');
      },
    ],
    [
      'a rejection',
      async () => {
        await Promise.resolve();
        throw new Error('signing key unavailable');
      },
    ],
  ])(
    '%s from apply is retried and then reported as a failure to connect, with nothing sent',
    async (_label, apply) => {
      const calls = jest.fn(apply);
      const retrying = new HttpClient({
        retry: { retries: 1, baseDelayMs: 1, maxDelayMs: 1, jitter: false },
      });
      await expect(
        withAllowedHosts('127.0.0.1', () =>
          retrying.get(`${providerOrigin}/ok`, { auth: failingApply(calls) }),
        ),
      ).rejects.toMatchObject({
        code: 'transport_unreachable',
        retryable: true,
        message: expect.stringContaining('signing key unavailable'),
      });
      expect(calls).toHaveBeenCalledTimes(2);
      expect(provider.hits).toHaveLength(0);
    },
  );

  it('keeps the error apply threw as the cause of the failure', async () => {
    const thrown = new Error('signing key unavailable');
    const failure = await withAllowedHosts('127.0.0.1', () =>
      http.get(`${providerOrigin}/ok`, {
        auth: failingApply(() => {
          throw thrown;
        }),
      }),
    ).catch((err: unknown) => err);
    expect(failure).toMatchObject({
      code: 'transport_unreachable',
      message: 'Error: signing key unavailable',
    });
    expect((failure as ActionError).cause).toMatchObject({
      name: 'Error',
      message: 'signing key unavailable',
      stack: thrown.stack,
    });
  });

  it('never calls apply for a request already aborted, so a rejecting signer has nothing to reject', async () => {
    const apply = jest.fn(async () => {
      await Promise.resolve();
      throw new Error('signing key unavailable');
    });
    const controller = new AbortController();
    controller.abort();
    const transport = new DirectTransport({
      scheme: { type: 'custom', origins: [providerOrigin], apply },
      credential: { type: 'apiKey', value: SECRET },
    });
    await expect(
      transport.send({ method: 'GET', url: `${providerOrigin}/ok`, headers: {}, signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'transport_timeout', message: 'request aborted before it was sent' });
    await expect(
      withAllowedHosts('127.0.0.1', () =>
        http.get(`${providerOrigin}/ok`, { auth: failingApply(apply), signal: controller.signal }),
      ),
    ).rejects.toMatchObject({ code: 'transport_timeout', message: 'request aborted by caller' });
    expect(apply).not.toHaveBeenCalled();
    expect(provider.hits).toHaveLength(0);
  });

  it('scrubs a credential out of the error apply threw before keeping it as the cause', async () => {
    const leaked = 'Bearer sk_live_1234567890abcdef';
    const failure = await withAllowedHosts('127.0.0.1', () =>
      http.get(`${providerOrigin}/ok`, {
        auth: failingApply(() => {
          throw new TypeError(`signer rejected ${leaked}`);
        }),
      }),
    ).catch((err: unknown) => err);
    const cause = (failure as ActionError).cause as Error;
    expect(cause).toMatchObject({ name: 'TypeError', message: 'signer rejected Bearer [redacted]' });
    expect(cause.stack).toContain('credential-origin.spec');
    expect(inspect(failure, { depth: Infinity })).not.toContain('sk_live_1234567890abcdef');
  });

  it('an ActionError thrown by apply keeps its code and is not retried when it says so', async () => {
    const calls = jest.fn(() => {
      throw new ActionError({ code: 'auth_missing', message: 'no signing key configured', retryable: false });
    });
    const retrying = new HttpClient({ retry: { retries: 1, baseDelayMs: 1, maxDelayMs: 1, jitter: false } });
    await expect(
      withAllowedHosts('127.0.0.1', () =>
        retrying.get(`${providerOrigin}/ok`, { auth: failingApply(calls) }),
      ),
    ).rejects.toMatchObject({ code: 'auth_missing', retryable: false });
    expect(calls).toHaveBeenCalledTimes(1);
    expect(provider.hits).toHaveLength(0);
  });

  it('a caller abort while an async apply is pending ends the call at once, with the usual abort error', async () => {
    const controller = new AbortController();
    const slow = new HttpClient({ retry: { retries: 0 }, defaultTimeoutMs: 5_000 });
    const started = Date.now();
    setTimeout(() => controller.abort(), 20);
    await expect(
      withAllowedHosts('127.0.0.1', () =>
        slow.get(`${providerOrigin}/ok`, {
          auth: failingApply(() => new Promise(() => undefined)),
          signal: controller.signal,
        }),
      ),
    ).rejects.toMatchObject({ code: 'transport_timeout', message: 'request aborted by caller' });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(provider.hits).toHaveLength(0);
  });

  it('DirectTransport.send with an aborted signal does not wait on a pending apply', async () => {
    const transport = new DirectTransport({
      scheme: { type: 'custom', origins: [providerOrigin], apply: () => new Promise(() => undefined) },
      credential: { type: 'apiKey', value: SECRET },
    });
    const controller = new AbortController();
    controller.abort();
    await expect(
      transport.send({ method: 'GET', url: `${providerOrigin}/ok`, headers: {}, signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'transport_timeout', message: 'request aborted before it was sent' });
    expect(provider.hits).toHaveLength(0);
  }, 2_000);

  it('a header object mutated after the first hop never reaches a later hop', async () => {
    const headers: Record<string, string> = { accept: 'application/json' };
    lateHeaders = headers;
    try {
      await withAllowedHosts('127.0.0.1', () => guardedFetch(`${providerOrigin}/mutate`, { headers }));
    } finally {
      lateHeaders = undefined;
    }
    expect(provider.hits.map((h) => [h.url, h.headers['x-late']])).toEqual([
      ['/mutate', undefined],
      ['/after', undefined],
    ]);
  });

  describe('a custom scheme that edits the body in place', () => {
    const inPlace = () =>
      createDirectAuth(
        {
          type: 'custom',
          origins: [providerOrigin],
          apply: (req, cred) => {
            if (cred.type === 'apiKey') (req.body as Record<string, unknown>).api_key = cred.value;
          },
        },
        { type: 'apiKey', value: SECRET },
      );

    it('refuses the retried attempt that would replay the signed body to another origin, and leaves the caller its own body', async () => {
      const retrying = new HttpClient({
        retry: { retries: 1, baseDelayMs: 1, maxDelayMs: 1, jitter: false },
      });
      const body = { a: 1 };
      await expect(
        withAllowedHosts('127.0.0.1', () =>
          retrying.put(`${providerOrigin}/flaky?to=${encodeURIComponent(`${foreignOrigin}/landing`)}`, {
            auth: inPlace(),
            body,
          }),
        ),
      ).rejects.toMatchObject({ code: 'credential_scope' });
      expect(provider.hits.map((h) => h.body)).toEqual([
        `{"a":1,"api_key":"${SECRET}"}`,
        `{"a":1,"api_key":"${SECRET}"}`,
      ]);
      expect(foreign.hits).toHaveLength(0);
      expect(body).toEqual({ a: 1 });
    });

    it('refuses a second call that reuses the same body object, and leaves the caller its own body', async () => {
      const auth = inPlace();
      const body = { a: 1 };
      await withAllowedHosts('127.0.0.1', () => http.put(`${providerOrigin}/ok`, { auth, body }));
      expect(body).toEqual({ a: 1 });
      await expect(
        withAllowedHosts('127.0.0.1', () =>
          http.put(redirectUrl(`${foreignOrigin}/landing`, 307), { auth, body }),
        ),
      ).rejects.toMatchObject({ code: 'credential_scope' });
      expect(foreign.hits).toHaveLength(0);
      expect(body).toEqual({ a: 1 });
    });
  });

  describe('a custom scheme that signs the body', () => {
    const bodyAuth = () =>
      createDirectAuth(
        {
          type: 'custom',
          origins: [providerOrigin],
          apply: (req, cred) => {
            if (cred.type === 'apiKey') req.body = { ...(req.body as object), api_key: cred.value };
          },
        },
        { type: 'apiKey', value: SECRET },
      );

    it.each([307, 308])('refuses to replay that body on a %i to another origin', async (status) => {
      await expect(
        withAllowedHosts('127.0.0.1', () =>
          http.post(redirectUrl(`${foreignOrigin}/landing`, status), {
            auth: bodyAuth(),
            body: { msg: 'hi' },
          }),
        ),
      ).rejects.toMatchObject({ code: 'credential_scope' });
      expect(provider.hits[0]!.body).toContain(SECRET);
      expect(foreign.hits).toHaveLength(0);
    });

    it('follows a 303, which drops the body, without the credential', async () => {
      const res = await withAllowedHosts('127.0.0.1', () =>
        http.post(redirectUrl(`${foreignOrigin}/landing`, 303), { auth: bodyAuth(), body: { msg: 'hi' } }),
      );
      expect(res.data).toBe('foreign');
      expect(foreign.hits.map((h) => [h.method, h.body])).toEqual([['GET', '']]);
    });
  });

  it('lets a credential-free handle reach any origin', async () => {
    const auth = createDirectAuth({ type: 'none' }, { type: 'none' });
    const res = await withAllowedHosts('127.0.0.1', () => http.get(`${foreignOrigin}/public`, { auth }));
    expect(res.data).toBe('foreign');
  });
});
