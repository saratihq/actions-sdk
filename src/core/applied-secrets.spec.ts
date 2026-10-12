import { inspect } from 'node:util';

import { fakeResponse } from '../testing/fakes';
import { type LoopbackServer, startLoopbackServer, withAllowedHosts } from '../testing/loopback-server';
import { MemoryStore } from '../testing/memory-store';
import { defineAction } from './action';
import type { AuthHandle, AuthScheme, DirectCredential, NoneScheme } from './auth';
import { createAuth, createDirectAuth } from './auth-factories';
import { ActionError } from './errors';
import { HttpClient } from './http/client';
import type { FetchLike, FetchLikeResponse, NormalizedResponse, Transport } from './http/types';
import { dropdown, resolveOptions } from './props';
import { defineTrigger } from './trigger';

const KEY = 'sk_live_1234567890abcdef';
const ORIGIN = 'https://api.example.com';
const http = new HttpClient({ retry: { retries: 0 } });

const keyHeader: AuthScheme = { type: 'apiKey', origins: [ORIGIN], in: 'header', name: 'x-api-key' };
const keyQuery: AuthScheme = { type: 'apiKey', origins: [ORIGIN], in: 'query', name: 'sig' };
const basicAuth: AuthScheme = { type: 'basic', origins: [ORIGIN] };
const keyAsUsername: AuthScheme = { type: 'basic', origins: [ORIGIN], keyAsUsername: true };
const apiKey = (value: string): DirectCredential => ({ type: 'apiKey', value });

const seen = (value: unknown): string => inspect(value, { depth: Infinity, showHidden: true });

function expectScrubbed(err: unknown, secrets: readonly string[]): void {
  const cause = err instanceof Error ? err.cause : undefined;
  for (const secret of secrets) {
    expect(seen(err)).not.toContain(secret);
    expect(seen(cause)).not.toContain(secret);
  }
  expect(seen(err)).toContain('[redacted]');
}

const failureOf = (work: Promise<unknown>): Promise<unknown> =>
  work.then(
    () => {
      throw new Error('expected a failure');
    },
    (err: unknown) => err,
  );

const replying =
  (reply: (url: string) => FetchLikeResponse): FetchLike =>
  (input) =>
    Promise.resolve(reply(String(input)));

const echoing = replying(() =>
  fakeResponse(200, JSON.stringify({ echo: KEY }), { 'content-type': 'application/json' }),
);

async function echoed(client: HttpClient, auth: AuthHandle): Promise<string> {
  const { data } = await client.get<{ echo: string }>(`${ORIGIN}/me`, { auth });
  return data.echo;
}

const callAction = (scheme: AuthScheme, origin = ORIGIN) =>
  defineAction({
    type: 'demo.call',
    name: 'Call',
    description: 'Calls the provider.',
    auth: scheme,
    props: {},
    run: async ({ auth, http: client }) => (await client.get(`${origin}/me`, { auth })).data,
  });

describe.each([
  [
    'the HTTP client',
    (scheme: AuthScheme, credential: DirectCredential, fetchImpl: FetchLike) =>
      http.get(`${ORIGIN}/me`, { auth: createDirectAuth(scheme, credential, { fetchImpl }) }),
  ],
  [
    'an action',
    (scheme: AuthScheme, credential: DirectCredential, fetchImpl: FetchLike) =>
      callAction(scheme).execute({
        auth: createDirectAuth(scheme, credential, { fetchImpl }),
        props: {},
        http,
      }),
  ],
])('%s never hands back the credential the transport applied', (_surface, call) => {
  it('when the provider echoes the key in a 401 body', async () => {
    const fetchImpl = replying(() =>
      fakeResponse(401, JSON.stringify({ message: `invalid api key ${KEY}` }), {
        'content-type': 'application/json',
      }),
    );
    const err = await failureOf(call(keyHeader, apiKey(KEY), fetchImpl));
    expect(err).toMatchObject({
      code: 'http_error',
      status: 401,
      message: 'HTTP 401: invalid api key [redacted]',
    });
    expectScrubbed(err, [KEY]);
  });

  it('when the echoed key straddles the point where the message is cut', async () => {
    const fetchImpl = replying(() => fakeResponse(401, `${'x'.repeat(190)}${KEY}`));
    const err = await failureOf(call(keyHeader, apiKey(KEY), fetchImpl));
    expect((err as Error).message).toBe(`HTTP 401: ${'x'.repeat(190)}[redacted]`);
    expect(seen(err)).not.toContain(KEY.slice(0, 8));
  });

  it('when a fetch failure names the URL that carries the key in a query param', async () => {
    const fetchImpl: FetchLike = (input) =>
      Promise.reject(new TypeError(`request to ${String(input)} failed`));
    const err = await failureOf(call(keyQuery, apiKey(KEY), fetchImpl));
    expect(err).toMatchObject({
      code: 'transport_unreachable',
      message: `TypeError: request to ${ORIGIN}/me?sig=[redacted] failed`,
    });
    expect((err as Error).cause).toMatchObject({ name: 'TypeError' });
    expectScrubbed(err, [KEY]);
  });

  it('in every spelling a query param gives a key that needs encoding', async () => {
    const odd = 'sk live~1234!abcd';
    const fetchImpl: FetchLike = (input) =>
      Promise.reject(new TypeError(`request to ${String(input)} failed`));
    const err = await failureOf(call(keyQuery, apiKey(odd), fetchImpl));
    expectScrubbed(err, [odd, encodeURIComponent(odd), new URLSearchParams({ v: odd }).toString().slice(2)]);
  });

  it("when the provider echoes Basic's base64(user:pass)", async () => {
    const credential: DirectCredential = { type: 'basic', username: 'me@acme.test', password: KEY };
    const pair = Buffer.from(`me@acme.test:${KEY}`).toString('base64');
    const fetchImpl = replying(() => fakeResponse(401, `rejected Authorization: Basic ${pair}`));
    const err = await failureOf(call(basicAuth, credential, fetchImpl));
    expect((err as Error).message).toBe('HTTP 401: rejected Authorization: Basic [redacted]');
    expectScrubbed(err, [pair, KEY]);
  });

  it("when a Basic connection's key is its username and its password a placeholder", async () => {
    const fetchImpl = replying(() => fakeResponse(401, `unknown api key ${KEY}`));
    for (const password of ['', 'X']) {
      const err = await failureOf(call(basicAuth, { type: 'basic', username: KEY, password }, fetchImpl));
      expect((err as Error).message).toBe('HTTP 401: unknown api key [redacted]');
      expectScrubbed(err, [KEY]);
    }
  });

  it('when a Basic scheme takes the key as its username and the password is a long placeholder', async () => {
    const fetchImpl = replying(() => fakeResponse(401, `unknown token ${KEY}`));
    const credential: DirectCredential = { type: 'basic', username: KEY, password: 'api_token' };
    const err = await failureOf(call(keyAsUsername, credential, fetchImpl));
    expect((err as Error).message).toBe('HTTP 401: unknown token [redacted]');
    expectScrubbed(err, [KEY]);
  });

  it('a Basic username is left alone when the password is the secret', async () => {
    const fetchImpl = replying(() => fakeResponse(401, 'no access for me@acme.test'));
    const credential: DirectCredential = { type: 'basic', username: 'me@acme.test', password: KEY };
    await expect(call(basicAuth, credential, fetchImpl)).rejects.toMatchObject({
      message: 'HTTP 401: no access for me@acme.test',
    });
  });

  it('when the provider echoes the key percent-encoded in lower case or JSON-escaped', async () => {
    const odd = 'ab/cd+ef="gh';
    const fetchImpl = replying(() =>
      fakeResponse(401, 'bad key ab%2fcd%2bef%3d%22gh / ab\\/cd+ef=\\"gh / ab/cd+ef=\\"gh'),
    );
    const err = await failureOf(call(keyQuery, apiKey(odd), fetchImpl));
    expect((err as Error).message).toBe('HTTP 401: bad key [redacted] / [redacted] / [redacted]');
  });

  it('a credential inside a machine field leaves the code, the name and the stack frames alone', async () => {
    const fetchImpl = replying(() => fakeResponse(401, 'nope'));
    const header = /^ActionError: HTTP 401: nope\n {4}at /;
    const coded = await failureOf(call(keyHeader, apiKey('http'), fetchImpl));
    expect(coded).toMatchObject({ name: 'ActionError', code: 'http_error', message: 'HTTP 401: nope' });
    const credential: DirectCredential = { type: 'basic', username: 'me@acme.test', password: 'Error' };
    const named = await failureOf(call(basicAuth, credential, fetchImpl));
    expect(named).toMatchObject({ name: 'ActionError', code: 'http_error' });
    expect((named as Error).stack).toMatch(header);
    const blank = await failureOf(call(keyHeader, apiKey('    '), fetchImpl));
    expect((blank as Error).stack).toMatch(header);
  });

  it('a credential shorter than four characters leaves text that contains it untouched', async () => {
    const fetchImpl = replying(() => fakeResponse(401, 'token expired; tok is unknown'));
    await expect(call(keyHeader, apiKey('tok'), fetchImpl)).rejects.toMatchObject({
      message: 'HTTP 401: token expired; tok is unknown',
    });
  });

  it('text that only shares a prefix with the key is untouched', async () => {
    const fetchImpl = replying(() => fakeResponse(401, 'sk_live_ keys are not accepted here'));
    await expect(call(keyHeader, apiKey(KEY), fetchImpl)).rejects.toMatchObject({
      message: 'HTTP 401: sk_live_ keys are not accepted here',
    });
  });
});

describe('an action that throws the key it was handed back never passes it on', () => {
  const throwing = (fail: (echo: string) => unknown) =>
    defineAction({
      type: 'demo.throwing',
      name: 'Throwing',
      description: 'Throws what the provider echoed.',
      auth: keyHeader,
      props: {
        choice: dropdown({
          label: 'Choice',
          required: false,
          options: async ({ auth, http: client }) => {
            throw fail(await echoed(client, auth));
          },
        }),
      },
      run: async ({ auth, http: client }) => {
        throw fail(await echoed(client, auth));
      },
    });
  const auth = () => createDirectAuth(keyHeader, apiKey(KEY), { fetchImpl: echoing });

  it.each([
    ['a plain Error', (echo: string) => new Error(`unexpected reply ${echo}`)],
    [
      'an ActionError whose detail and cause carry it',
      (echo: string) =>
        new ActionError({
          code: 'provider_error',
          message: `rejected ${echo}`,
          detail: { reply: { echo }, seen: [echo] },
          cause: new Error(`upstream said ${echo}`, { cause: new RangeError(echo) }),
        }),
    ],
    [
      'an Error whose own properties carry it',
      (echo: string) =>
        Object.assign(new Error('upstream failed'), {
          url: `${ORIGIN}/x?sig=${echo}`,
          response: new Headers({ authorization: echo }),
        }),
    ],
    ['a thrown string', (echo: string) => `failed with ${echo}`],
    [
      'an ActionError whose detail keys carry it',
      (echo: string) =>
        new ActionError({ code: 'provider_error', message: 'bad', detail: { [echo]: 'revoked' } }),
    ],
    [
      'an error whose hidden name carries it',
      (echo: string) =>
        Object.defineProperty(new ActionError({ code: 'provider_error', message: 'bad' }), 'name', {
          value: `Rejected(${echo})`,
          enumerable: false,
        }),
    ],
    [
      'an ActionError whose detail holds a symbol described by it',
      (echo: string) =>
        new ActionError({ code: 'provider_error', message: `rejected ${echo}`, detail: { s: Symbol(echo) } }),
    ],
  ])('%s, from run or from an options loader', async (_kind, fail) => {
    const action = throwing(fail);
    expectScrubbed(await failureOf(action.execute({ auth: auth(), props: {}, http })), [KEY]);
    expectScrubbed(await failureOf(action.loadOptions('choice', { auth: auth(), http })), [KEY]);
  });

  it('keeps what it can scrub and the shape of the failure', async () => {
    const err = await failureOf(
      throwing(
        (echo) =>
          new ActionError({
            code: 'provider_error',
            message: `rejected ${echo}`,
            status: 429,
            retryable: true,
            detail: { reply: echo, count: 3 },
          }),
      ).execute({ auth: auth(), props: {}, http }),
    );
    expect(err).toBeInstanceOf(ActionError);
    expect(err).toMatchObject({
      code: 'provider_error',
      status: 429,
      retryable: true,
      message: 'rejected [redacted]',
      detail: { reply: '[redacted]', count: 3 },
    });
    expect((err as Error).stack).toMatch(/^ActionError: rejected \[redacted\]\n\s+at /);
  });

  it('keeps a "__proto__" key as a key, not as the prototype of the copy', async () => {
    const err = await failureOf(
      throwing(
        (echo) =>
          new ActionError({
            code: 'provider_error',
            message: 'bad',
            detail: JSON.parse(`{"__proto__":{"echo":"${echo}"},"y":1}`),
          }),
      ).execute({ auth: auth(), props: {}, http }),
    );
    const detail = (err as ActionError).detail as object;
    expect(Object.getPrototypeOf(detail)).toBe(Object.prototype);
    expect(Object.keys(detail)).toEqual(['__proto__', 'y']);
    expect(Object.getOwnPropertyDescriptor(detail, '__proto__')?.value).toEqual({ echo: '[redacted]' });
  });

  it('drops a property it cannot read and keeps the rest of the failure', async () => {
    const action = throwing((echo) =>
      Object.defineProperty(new Error(`upstream failed for ${echo}`), 'body', {
        enumerable: true,
        get: () => {
          throw new Error(`body unavailable for ${echo}`);
        },
      }),
    );
    for (const run of [
      () => action.execute({ auth: auth(), props: {}, http }),
      () => action.loadOptions('choice', { auth: auth(), http }),
    ]) {
      const err = await failureOf(run());
      expect(err).toMatchObject({ message: 'upstream failed for [redacted]' });
      expectScrubbed(err, [KEY]);
      expect(seen(err)).not.toContain('body');
    }
  });

  it.each([
    [
      'a message getter that throws',
      (echo: string) =>
        Object.defineProperty(new Error('unread'), 'message', {
          get: () => {
            throw new Error(`no message for ${echo}`);
          },
        }),
    ],
    [
      'a prototype that cannot be read',
      (echo: string) =>
        new Proxy(new Error('unread'), {
          getPrototypeOf: () => {
            throw new Error(`no prototype for ${echo}`);
          },
        }),
    ],
  ])('withholds a failure it cannot read at all (%s) rather than passing it on', async (_kind, fail) => {
    const action = throwing(fail);
    for (const run of [
      () => action.execute({ auth: auth(), props: {}, http }),
      () => action.loadOptions('choice', { auth: auth(), http }),
    ]) {
      const err = await failureOf(run());
      expect(err).toBeInstanceOf(ActionError);
      expect(err).toMatchObject({ code: 'unknown', retryable: false, message: '[redacted]' });
      expectScrubbed(err, [KEY]);
    }
  });

  it('an error that names itself as its cause still comes back', async () => {
    const err = await failureOf(
      throwing((echo) => {
        const loop = new Error(`loop ${echo}`);
        loop.cause = loop;
        return loop;
      }).execute({ auth: auth(), props: {}, http }),
    );
    expectScrubbed(err, [KEY]);
  });

  it('a failure with nothing secret in it comes back unchanged', async () => {
    const original = new ActionError({
      code: 'provider_error',
      message: 'quota exceeded',
      status: 429,
      retryable: true,
      detail: { provider: 'demo', count: 3 },
    });
    const err = await failureOf(throwing(() => original).execute({ auth: auth(), props: {}, http }));
    expect(err).toMatchObject({
      code: original.code,
      status: original.status,
      retryable: original.retryable,
      message: original.message,
      detail: original.detail,
      stack: original.stack,
    });
  });
});

describe('a trigger that throws the key it was handed back never passes it on', () => {
  const auth = () => createDirectAuth(keyHeader, apiKey(KEY), { fetchImpl: echoing });
  const fail = async (step: string, client: HttpClient, handle: AuthHandle): Promise<never> => {
    throw new Error(`${step} failed: ${await echoed(client, handle)}`);
  };
  const polling = defineTrigger({
    type: 'demo.polling',
    name: 'Polling',
    description: 'Polls.',
    auth: keyHeader,
    props: {},
    strategy: 'polling',
    poll: ({ auth: handle, http: client }) => fail('poll', client, handle),
    dedupeKey: (item: { id: string }) => item.id,
  });
  const webhook = defineTrigger({
    type: 'demo.webhook',
    name: 'Webhook',
    description: 'Listens.',
    auth: keyHeader,
    props: {},
    strategy: 'webhook',
    onEnable: ({ auth: handle, http: client }) => fail('enable', client, handle),
    onDisable: ({ auth: handle, http: client }) => fail('disable', client, handle),
    onRequest: ({ auth: handle, http: client }) => fail('request', client, handle),
  });
  const hook = { props: {}, store: new MemoryStore(), webhookUrl: 'https://hooks.test/1', secret: 's', http };

  it.each([
    ['runPoll', () => polling.runPoll({ auth: auth(), props: {}, store: new MemoryStore(), http })],
    ['enable', () => webhook.enable({ ...hook, auth: auth() })],
    ['disable', () => webhook.disable({ ...hook, auth: auth() })],
    [
      'handleRequest',
      () => webhook.handleRequest({ ...hook, auth: auth(), request: { headers: {}, body: {} } }),
    ],
  ])('%s', async (_step, run) => {
    expectScrubbed(await failureOf(run()), [KEY]);
  });

  const badItem = (item: { id: string }): never => {
    throw new Error(`bad item ${item.id}`);
  };
  const echoedItems = async ({ auth: handle, http: client }: { auth: AuthHandle; http: HttpClient }) => [
    { id: await echoed(client, handle) },
  ];

  it.each([
    [
      "runPoll's dedupeKey",
      () =>
        defineTrigger({
          type: 'demo.polled',
          name: 'Polled',
          description: 'Polls items keyed by what the provider echoed.',
          auth: keyHeader,
          props: {},
          strategy: 'polling',
          poll: echoedItems,
          dedupeKey: badItem,
        }).runPoll({ auth: auth(), props: {}, store: new MemoryStore(), http }),
    ],
    [
      "handleRequest's dedupeKey",
      () =>
        defineTrigger({
          type: 'demo.keyed',
          name: 'Keyed',
          description: 'Listens for items keyed by what the provider echoed.',
          auth: keyHeader,
          props: {},
          strategy: 'webhook',
          onRequest: echoedItems,
          dedupeKey: badItem,
        }).handleRequest({ ...hook, auth: auth(), request: { headers: {}, body: {} } }),
    ],
    [
      "handleRequest's verify",
      () =>
        defineTrigger({
          type: 'demo.verified',
          name: 'Verified',
          description: 'Listens for signed requests.',
          auth: keyHeader,
          props: {},
          strategy: 'webhook',
          verify: (request) => {
            throw new Error(`unexpected payload ${JSON.stringify(request.body)}`);
          },
          onRequest: () => [],
        }).handleRequest({ ...hook, auth: auth(), request: { headers: {}, body: { token: KEY } } }),
    ],
  ])('%s', async (_step, run) => {
    expectScrubbed(await failureOf(run()), [KEY]);
  });

  it('a dropdown the host loads through resolveOptions', async () => {
    const choosy = defineTrigger({
      type: 'demo.choosy',
      name: 'Choosy',
      description: 'Listens for one choice.',
      auth: keyHeader,
      props: {
        choice: dropdown({
          label: 'Choice',
          required: false,
          options: async ({ auth: handle, http: client }) => {
            throw new Error(`bad list ${await echoed(client, handle)}`);
          },
        }),
      },
      strategy: 'webhook',
      onRequest: () => [],
    });
    const err = await failureOf(resolveOptions(choosy.props.choice, { auth: auth(), http }));
    expect(err).toMatchObject({ message: 'bad list [redacted]' });
    expectScrubbed(err, [KEY]);
  });
});

describe('a host transport that supplies redact', () => {
  const HOST_SECRET = 'host-secret-9f8e7d';

  class HostTransport implements Transport {
    readonly kind = 'host';
    readonly redact = jest.fn((text: string) => text.split(HOST_SECRET).join('[redacted]'));

    constructor(private readonly reply: NormalizedResponse) {}

    send(): Promise<NormalizedResponse> {
      return Promise.resolve(this.reply);
    }
  }

  it('has it applied through the credential scope createAuth adds', async () => {
    const host = new HostTransport({ status: 401, headers: {}, data: `bad proxy key ${HOST_SECRET}` });
    const err = await failureOf(
      callAction(keyHeader).execute({ auth: createAuth(keyHeader, host), props: {}, http }),
    );
    expect(err).toMatchObject({ message: 'HTTP 401: bad proxy key [redacted]' });
    expectScrubbed(err, [HOST_SECRET]);
  });

  it('that throws has the failure withheld, never passed on raw', async () => {
    const host = new HostTransport({ status: 401, headers: {}, data: `bad proxy key ${HOST_SECRET}` });
    host.redact.mockImplementation((text: string) => {
      throw new Error(`cannot redact ${HOST_SECRET} in ${text}`);
    });
    const err = await failureOf(
      callAction(keyHeader).execute({ auth: createAuth(keyHeader, host), props: {}, http }),
    );
    expect(err).toMatchObject({ code: 'http_error', status: 401, retryable: false, message: '[redacted]' });
    expectScrubbed(err, [HOST_SECRET]);
  });

  it('is never asked to redact on a call that succeeds', async () => {
    const host = new HostTransport({ status: 200, headers: {}, data: { ok: true } });
    await expect(
      callAction(keyHeader).execute({ auth: createAuth(keyHeader, host), props: {}, http }),
    ).resolves.toEqual({ ok: true });
    expect(host.redact).not.toHaveBeenCalled();
  });
});

describe('a host transport with no redact whose send throws its own error', () => {
  const host = (thrown: Error): Transport => ({ kind: 'host', send: () => Promise.reject(thrown) });
  const get = (thrown: Error) =>
    failureOf(http.get(`${ORIGIN}/me`, { auth: createAuth(keyHeader, host(thrown)) }));

  it('never passes on the request the error carried', async () => {
    const err = await get(
      Object.assign(new Error('Request failed with status code 401'), {
        config: { headers: { 'x-api-key': KEY } },
        response: { data: { error: `bad key ${KEY}` } },
      }),
    );
    expect(err).toMatchObject({ code: 'transport_unreachable' });
    expect(seen(err)).not.toContain(KEY);
  });

  it('keeps what diagnoses it: name, message, code, errno, syscall and the same of its cause', async () => {
    const reason = Object.assign(new Error('connect ECONNREFUSED 203.0.113.9:443'), {
      code: 'ECONNREFUSED',
      errno: -61,
      syscall: 'connect',
      request: { headers: { 'x-api-key': KEY } },
    });
    const err = await get(
      Object.assign(new TypeError('fetch failed', { cause: reason }), { config: { apiKey: KEY } }),
    );
    expect(err).toMatchObject({ code: 'transport_unreachable', message: 'TypeError: fetch failed' });
    const cause = (err as Error).cause as Error;
    expect(cause).toBeInstanceOf(Error);
    expect(cause).toMatchObject({ name: 'TypeError', message: 'fetch failed' });
    expect(cause).not.toHaveProperty('config');
    expect(cause.stack).toMatch(/^TypeError: fetch failed\n\s+at /);
    expect(cause.cause).toMatchObject({
      name: 'Error',
      message: 'connect ECONNREFUSED 203.0.113.9:443',
      code: 'ECONNREFUSED',
      errno: -61,
      syscall: 'connect',
    });
    expect(cause.cause).not.toHaveProperty('request');
    expect(seen(err)).not.toContain(KEY);
  });
});

type Unscoped<T> = T extends unknown ? Omit<T, 'origins'> : never;

describe('a credential saved with whitespace around it, which the network hop sends trimmed', () => {
  let server: LoopbackServer;
  let base: string;

  beforeAll(async () => {
    server = await startLoopbackServer((req, res) => {
      const query = new URL(req.url ?? '/', 'http://loopback').searchParams.get('sig')?.trim();
      const sent = query ?? req.headers['x-api-key'] ?? req.headers.authorization?.replace(/^Bearer +/, '');
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: `invalid api key ${String(sent)}` }));
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterAll(() => server.close());

  it.each<[string, Unscoped<Exclude<AuthScheme, NoneScheme>>, DirectCredential]>([
    [
      'an apiKey header saved with a trailing newline',
      { type: 'apiKey', in: 'header', name: 'x-api-key' },
      apiKey(`${KEY}\n`),
    ],
    ['a bearer token saved with spaces around it', { type: 'oauth2' }, { type: 'bearer', token: ` ${KEY} ` }],
    [
      'a query apiKey saved with a trailing space that the provider trims',
      { type: 'apiKey', in: 'query', name: 'sig' },
      apiKey(`${KEY} `),
    ],
  ])('%s', async (_label, unscoped, credential) => {
    const scheme: AuthScheme = { ...unscoped, origins: [base] };
    const err = await withAllowedHosts('127.0.0.1', () =>
      failureOf(
        callAction(scheme, base).execute({ auth: createDirectAuth(scheme, credential), props: {}, http }),
      ),
    );
    expect(err).toMatchObject({
      code: 'http_error',
      status: 401,
      message: 'HTTP 401: invalid api key [redacted]',
    });
    expectScrubbed(err, [KEY]);
  });
});
