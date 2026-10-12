import { inspect } from 'node:util';

import { fakeResponse } from '../testing/fakes';
import { MemoryStore } from '../testing/memory-store';
import { defineAction } from './action';
import type { AuthHandle, AuthScheme, DirectCredential } from './auth';
import { createAuth, createDirectAuth } from './auth-factories';
import { ActionError } from './errors';
import { HttpClient } from './http/client';
import type { FetchLike, FetchLikeResponse, NormalizedResponse, Transport } from './http/types';
import { dropdown } from './props';
import { defineTrigger } from './trigger';

const KEY = 'sk_live_1234567890abcdef';
const ORIGIN = 'https://api.example.com';
const http = new HttpClient({ retry: { retries: 0 } });

const keyHeader: AuthScheme = { type: 'apiKey', origins: [ORIGIN], in: 'header', name: 'x-api-key' };
const keyQuery: AuthScheme = { type: 'apiKey', origins: [ORIGIN], in: 'query', name: 'sig' };
const basicAuth: AuthScheme = { type: 'basic', origins: [ORIGIN] };
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

const callAction = (scheme: AuthScheme) =>
  defineAction({
    type: 'demo.call',
    name: 'Call',
    description: 'Calls the provider.',
    auth: scheme,
    props: {},
    run: async ({ auth, http: client }) => (await client.get(`${ORIGIN}/me`, { auth })).data,
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

  it('is never asked to redact on a call that succeeds', async () => {
    const host = new HostTransport({ status: 200, headers: {}, data: { ok: true } });
    await expect(
      callAction(keyHeader).execute({ auth: createAuth(keyHeader, host), props: {}, http }),
    ).resolves.toEqual({ ok: true });
    expect(host.redact).not.toHaveBeenCalled();
  });
});
