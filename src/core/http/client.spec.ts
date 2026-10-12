import { createAuth } from '../auth-factories';
import { ActionError } from '../errors';
import { FakeTransport, stubAuth } from '../../testing/fakes';
import { HttpClient } from './client';
import type { NormalizedResponse, Transport } from './types';

const FAST_RETRY = { retries: 3, baseDelayMs: 1, maxDelayMs: 2, jitter: false };

function ok(data: unknown, status = 200, headers: Record<string, string> = {}): NormalizedResponse {
  return { status, headers, data };
}

describe('HttpClient', () => {
  it('returns 2xx data and merges query params into the URL', async () => {
    const transport = new FakeTransport(() => ok({ hello: 'world' }));
    const client = new HttpClient();
    const res = await client.get<{ hello: string }>('https://api.test/x', {
      auth: stubAuth(transport),
      query: { a: 1, b: ['p', 'q'] },
    });
    expect(res.data).toEqual({ hello: 'world' });
    expect(transport.requests[0]?.url).toBe('https://api.test/x?a=1&b=p&b=q');
  });

  it('throws the normalized failure shape on a non-2xx', async () => {
    const transport = new FakeTransport(() => ok({ message: 'not found' }, 404));
    const client = new HttpClient({ retry: FAST_RETRY });
    await expect(client.get('https://api.test/x', { auth: stubAuth(transport) })).rejects.toMatchObject({
      status: 404,
      retryable: false,
    });
  });

  it('returns the response instead of throwing when throwOnError is false', async () => {
    const transport = new FakeTransport(() => ok({ err: 'bad' }, 400));
    const client = new HttpClient();
    const res = await client.get('https://api.test/x', { auth: stubAuth(transport), throwOnError: false });
    expect(res.status).toBe(400);
  });

  it('retries a retryable failure on an idempotent GET, then succeeds', async () => {
    const transport = new FakeTransport((_, i) => (i === 0 ? ok('boom', 503) : ok({ ok: true })));
    const client = new HttpClient({ retry: FAST_RETRY });
    const res = await client.get<{ ok: boolean }>('https://api.test/x', { auth: stubAuth(transport) });
    expect(res.data).toEqual({ ok: true });
    expect(transport.requests).toHaveLength(2);
  });

  it('does NOT retry a POST on a 500 (no double-side-effect)', async () => {
    const transport = new FakeTransport(() => ok('server error', 500));
    const client = new HttpClient({ retry: FAST_RETRY });
    await expect(
      client.post('https://api.test/x', { auth: stubAuth(transport), body: { a: 1 } }),
    ).rejects.toBeInstanceOf(ActionError);
    expect(transport.requests).toHaveLength(1);
  });

  it('DOES retry a POST when the transport never reached the server (status 0)', async () => {
    let calls = 0;
    const transport = new FakeTransport(() => {
      calls += 1;
      if (calls === 1) throw new ActionError({ code: 'transport_unreachable', message: 'down', status: 0 });
      return ok({ ok: true });
    });
    const client = new HttpClient({ retry: FAST_RETRY });
    const res = await client.post<{ ok: boolean }>('https://api.test/x', {
      auth: stubAuth(transport),
      body: { a: 1 },
    });
    expect(res.data).toEqual({ ok: true });
    expect(calls).toBe(2);
  });

  it('retries an explicitly-idempotent POST', async () => {
    const transport = new FakeTransport((_, i) => (i === 0 ? ok('x', 503) : ok({ ok: true })));
    const client = new HttpClient({ retry: FAST_RETRY });
    const res = await client.post<{ ok: boolean }>('https://api.test/x', {
      auth: stubAuth(transport),
      body: { a: 1 },
      idempotent: true,
    });
    expect(res.data).toEqual({ ok: true });
    expect(transport.requests).toHaveLength(2);
  });

  it('gives up after the retry budget and throws', async () => {
    const transport = new FakeTransport(() => ok('always', 503));
    const client = new HttpClient({ retry: FAST_RETRY });
    await expect(client.get('https://api.test/x', { auth: stubAuth(transport) })).rejects.toMatchObject({
      status: 503,
      retryable: true,
    });
    expect(transport.requests).toHaveLength(4); // 1 + 3 retries
  });

  it('enforces the timeout even if the transport ignores the abort signal', async () => {
    const hanging = new FakeTransport(() => ok({}));
    // Override send to hang forever regardless of the signal.
    jest.spyOn(hanging, 'send').mockImplementation(() => new Promise<never>(() => undefined));
    const client = new HttpClient({ retry: { ...FAST_RETRY, retries: 0 } });
    await expect(
      client.get('https://api.test/x', { auth: stubAuth(hanging), timeoutMs: 20 }),
    ).rejects.toThrow(/timed out/);
  });
});

describe('HttpClient — a caller abort', () => {
  const aborted = (): AbortSignal => {
    const controller = new AbortController();
    controller.abort();
    return controller.signal;
  };

  it('is never handed to the transport when the signal is already aborted, even one that ignores signals', async () => {
    const sends: string[] = [];
    const deaf: Transport = {
      kind: 'deaf',
      send: (req) => {
        sends.push(req.url);
        return new Promise((resolve) =>
          setTimeout(() => resolve({ status: 200, headers: {}, data: null }), 20),
        );
      },
    };
    await expect(
      new HttpClient().post('https://api.test/charge', {
        auth: createAuth({ type: 'oauth2', origins: ['https://api.test'] }, deaf),
        body: { amount: 1 },
        signal: aborted(),
      }),
    ).rejects.toMatchObject({
      code: 'transport_timeout',
      message: 'request aborted by caller',
      retryable: false,
    });
    expect(sends).toEqual([]);
  });

  it.each([
    ['the backoff', {}],
    ['a Retry-After wait', { 'retry-after': '5' }],
  ])('during %s ends with the same ActionError as any other abort', async (_label, headers) => {
    const transport = new FakeTransport(() => ({ status: 503, headers, data: null }));
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);
    const failure = await new HttpClient({ retry: { retries: 3, baseDelayMs: 1_000, jitter: false } })
      .get('https://api.test/x', { auth: stubAuth(transport), signal: controller.signal })
      .catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(ActionError);
    expect(failure).toMatchObject({
      code: 'transport_timeout',
      message: 'request aborted by caller',
      retryable: false,
    });
    expect(transport.requests).toHaveLength(1);
  });
});
