import { FakeTransport, stubAuth } from '../../testing/fakes';
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

  it('blocks a request to a private/internal endpoint before it is sent (SSRF guard)', async () => {
    const transport = new FakeTransport(() => ({ status: 200, headers: {}, data: {} }));
    await expect(
      sendRequest.execute({
        auth: stubAuth(transport),
        props: { url: 'http://10.0.0.5/graphql', query: '{ x }' },
      }),
    ).rejects.toMatchObject({ code: 'ssrf_blocked' });
    expect(transport.requests).toHaveLength(0); // guard fired before any post
  });

  it('exposes one action, graphql.* typed', () => {
    expect(graphqlActions).toHaveLength(1);
    for (const action of graphqlActions) expect(action.type.startsWith('graphql.')).toBe(true);
  });
});
