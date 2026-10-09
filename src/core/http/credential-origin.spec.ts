import type { AuthScheme, DirectCredential, NoneScheme } from '../auth';
import { createDirectAuth } from '../auth-factories';
import {
  type LoopbackHit,
  type LoopbackServer,
  startLoopbackServer,
  withAllowedHosts,
} from '../../testing/loopback-server';
import { HttpClient } from './client';
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

  it('lets a credential-free handle reach any origin', async () => {
    const auth = createDirectAuth({ type: 'none' }, { type: 'none' });
    const res = await withAllowedHosts('127.0.0.1', () => http.get(`${foreignOrigin}/public`, { auth }));
    expect(res.data).toBe('foreign');
  });
});
