import { createDirectAuth } from '../../core/auth-factories';
import { FakeTransport, stubAuth } from '../../testing/fakes';
import { startLoopbackServer, withAllowedHosts } from '../../testing/loopback-server';
import { graphqlActions, sendRequest } from './index';

describe('graphql.send_request', () => {
  it('posts the query + variables and returns the data envelope', async () => {
    const transport = new FakeTransport(() => ({
      status: 200,
      headers: {},
      data: { data: { viewer: { login: 'ann' } } },
    }));
    const out = await sendRequest.execute({
      auth: stubAuth(transport),
      props: {
        url: 'https://api.test/graphql',
        query: 'query($id:ID!){ node(id:$id){ id } }',
        variables: { id: '1' },
        headers: { Authorization: 'Bearer t' },
      },
    });
    expect(out).toEqual({ status: 200, data: { viewer: { login: 'ann' } }, errors: null });
    const req = transport.requests[0]!;
    expect(req.method).toBe('POST');
    expect(req.body).toEqual({ query: 'query($id:ID!){ node(id:$id){ id } }', variables: { id: '1' } });
    expect(req.headers['authorization']).toBe('Bearer t');
  });

  it('surfaces GraphQL errors without throwing', async () => {
    const transport = new FakeTransport(() => ({
      status: 200,
      headers: {},
      data: { errors: [{ message: 'boom' }] },
    }));
    const out = await sendRequest.execute({
      auth: stubAuth(transport),
      props: { url: 'https://api.test/graphql', query: '{ x }' },
    });
    expect(out.errors).toEqual([{ message: 'boom' }]);
    expect(out.data).toBeNull();
  });

  it('rejects an endpoint without a scheme as invalid input instead of retrying it', async () => {
    await expect(
      sendRequest.execute({
        auth: createDirectAuth({ type: 'none' }, { type: 'none' }),
        props: { url: 'example.com/graphql', query: '{ x }' },
      }),
    ).rejects.toMatchObject({ code: 'invalid_input', retryable: false });
  });

  it('is refused by the transport before reaching a private endpoint (SSRF guard)', async () => {
    const server = await startLoopbackServer();
    try {
      await withAllowedHosts('', async () => {
        await expect(
          sendRequest.execute({
            auth: createDirectAuth({ type: 'none' }, { type: 'none' }),
            props: { url: `http://127.0.0.1:${server.port}/graphql`, query: '{ x }' },
          }),
        ).rejects.toMatchObject({ code: 'ssrf_blocked' });
      });
      expect(server.hits).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  it('exposes one action, graphql.* typed', () => {
    expect(graphqlActions).toHaveLength(1);
    for (const action of graphqlActions) expect(action.type.startsWith('graphql.')).toBe(true);
  });
});
