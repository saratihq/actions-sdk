import type { NormalizedResponse } from '../../core/http/types';
import { FakeTransport, stubAuth } from '../../testing/fakes';
import { MemoryStore } from '../../testing/memory-store';
import { httpActions, newItem, parseUrl, sendRequest } from './index';

const noAuth = stubAuth(new FakeTransport(() => ({ status: 200, headers: {}, data: {} })));

describe('http.send_request', () => {
  it('issues the request and returns status/headers/body', async () => {
    const transport = new FakeTransport(() => ({
      status: 201,
      headers: { 'content-type': 'application/json' },
      data: { ok: true },
    }));
    const out = await sendRequest.execute({
      auth: stubAuth(transport),
      props: {
        method: 'POST',
        url: 'https://api.test/things',
        headers: { 'X-Api-Key': 'abc' },
        queryParams: { page: 2 },
        body: { name: 'x' },
      },
    });
    expect(out).toEqual({ status: 201, headers: { 'content-type': 'application/json' }, body: { ok: true } });
    const req = transport.requests[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('https://api.test/things?page=2');
    expect(req.headers['x-api-key']).toBe('abc');
    expect(req.body).toEqual({ name: 'x' });
  });

  it('omits the body for GET/HEAD', async () => {
    const transport = new FakeTransport(() => ({ status: 200, headers: {}, data: [] }));
    await sendRequest.execute({
      auth: stubAuth(transport),
      props: { method: 'GET', url: 'https://api.test/list', body: { ignored: true } },
    });
    expect(transport.requests[0]!.body).toBeUndefined();
  });

  it('returns a non-2xx response when failOnError is false', async () => {
    const transport = new FakeTransport(() => ({ status: 404, headers: {}, data: { error: 'nope' } }));
    const out = await sendRequest.execute({
      auth: stubAuth(transport),
      props: { method: 'GET', url: 'https://api.test/missing', failOnError: false },
    });
    expect(out.status).toBe(404);
  });

  it('blocks a request to a private/internal address before it is sent (SSRF guard)', async () => {
    const transport = new FakeTransport(() => ({ status: 200, headers: {}, data: {} }));
    await expect(
      sendRequest.execute({
        auth: stubAuth(transport),
        props: { method: 'GET', url: 'http://169.254.169.254/latest/meta-data/' },
      }),
    ).rejects.toMatchObject({ code: 'ssrf_blocked' });
    expect(transport.requests).toHaveLength(0); // guard fired before any fetch
  });
});

describe('http.parse_url', () => {
  it('breaks a URL into components and query', async () => {
    const out = await parseUrl.execute({
      auth: noAuth,
      props: { url: 'https://user@example.com:8443/a/b?x=1&y=2#frag' },
    });
    expect(out).toMatchObject({
      protocol: 'https:',
      hostname: 'example.com',
      port: '8443',
      pathname: '/a/b',
      hash: '#frag',
      query: { x: '1', y: '2' },
    });
  });

  it('rejects a malformed URL', async () => {
    await expect(parseUrl.execute({ auth: noAuth, props: { url: 'not a url' } })).rejects.toMatchObject({
      code: 'invalid_input',
    });
  });
});

describe('http.new_item polling trigger', () => {
  function listResponse(ids: number[]): NormalizedResponse {
    return { status: 200, headers: {}, data: { items: ids.map((id) => ({ id, title: `t${id}` })) } };
  }

  it('emits new items, then dedupes on the next poll', async () => {
    const store = new MemoryStore();
    const t1 = new FakeTransport(() => listResponse([1, 2]));
    const first = await newItem.runPoll({
      auth: stubAuth(t1),
      props: { url: 'https://api.test/feed', itemsPath: 'items' },
      store,
    });
    expect(first.events.map((e) => (e as { id: number }).id)).toEqual([1, 2]);

    const t2 = new FakeTransport(() => listResponse([1, 2]));
    const second = await newItem.runPoll({
      auth: stubAuth(t2),
      props: { url: 'https://api.test/feed', itemsPath: 'items' },
      store,
    });
    expect(second.events).toEqual([]);

    const t3 = new FakeTransport(() => listResponse([1, 2, 3]));
    const third = await newItem.runPoll({
      auth: stubAuth(t3),
      props: { url: 'https://api.test/feed', itemsPath: 'items' },
      store,
    });
    expect(third.events.map((e) => (e as { id: number }).id)).toEqual([3]);
  });

  it('treats the whole body as the array when no path is given', async () => {
    const store = new MemoryStore();
    const transport = new FakeTransport(() => ({
      status: 200,
      headers: {},
      data: [{ id: 'a' }, { id: 'b' }],
    }));
    const out = await newItem.runPoll({
      auth: stubAuth(transport),
      props: { url: 'https://api.test/arr' },
      store,
    });
    expect(out.events).toHaveLength(2);
  });

  it('blocks polling a private/internal address before any fetch (SSRF guard)', async () => {
    const store = new MemoryStore();
    const transport = new FakeTransport(() => listResponse([1]));
    await expect(
      newItem.runPoll({ auth: stubAuth(transport), props: { url: 'http://127.0.0.1:8001/feed' }, store }),
    ).rejects.toMatchObject({ code: 'ssrf_blocked' });
    expect(transport.requests).toHaveLength(0); // guard fired before any fetch
  });
});

describe('http catalog', () => {
  it('exposes two actions, all http.* typed', () => {
    expect(httpActions).toHaveLength(2);
    for (const action of httpActions) expect(action.type.startsWith('http.')).toBe(true);
  });
});
