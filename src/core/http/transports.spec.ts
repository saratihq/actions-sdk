import type { AuthScheme } from '../auth';
import { fakeFetch, fakeResponse } from '../../testing/fakes';
import { DirectTransport } from './transport-direct';
import type { NormalizedRequest } from './types';

const baseReq: NormalizedRequest = { method: 'GET', url: 'https://api.test/x', headers: {} };

describe('DirectTransport — credential injection', () => {
  it('attaches an OAuth2 bearer token', async () => {
    const fetchImpl = fakeFetch(() =>
      fakeResponse(200, '{"ok":true}', { 'content-type': 'application/json' }),
    );
    const t = new DirectTransport({
      scheme: { type: 'oauth2' },
      credential: { type: 'bearer', token: 'T0K' },
      fetchImpl,
    });
    await t.send(baseReq);
    expect(fetchImpl.calls[0]?.init?.headers?.['authorization']).toBe('Bearer T0K');
  });

  it('attaches an apiKey header with a prefix', async () => {
    const scheme: AuthScheme = { type: 'apiKey', in: 'header', name: 'Authorization', prefix: 'token ' };
    const fetchImpl = fakeFetch(() => fakeResponse(200, '{}', { 'content-type': 'application/json' }));
    const t = new DirectTransport({ scheme, credential: { type: 'apiKey', value: 'ABC' }, fetchImpl });
    await t.send(baseReq);
    expect(fetchImpl.calls[0]?.init?.headers?.['authorization']).toBe('token ABC');
  });

  it('attaches an apiKey in the query string', async () => {
    const scheme: AuthScheme = { type: 'apiKey', in: 'query', name: 'api_key' };
    const fetchImpl = fakeFetch(() => fakeResponse(200, '{}', { 'content-type': 'application/json' }));
    const t = new DirectTransport({ scheme, credential: { type: 'apiKey', value: 'K' }, fetchImpl });
    await t.send(baseReq);
    expect(fetchImpl.calls[0]?.url).toBe('https://api.test/x?api_key=K');
  });

  it('encodes HTTP Basic', async () => {
    const fetchImpl = fakeFetch(() => fakeResponse(200, '{}', { 'content-type': 'application/json' }));
    const t = new DirectTransport({
      scheme: { type: 'basic' },
      credential: { type: 'basic', username: 'u', password: 'p' },
      fetchImpl,
    });
    await t.send(baseReq);
    expect(fetchImpl.calls[0]?.init?.headers?.['authorization']).toBe(
      `Basic ${Buffer.from('u:p').toString('base64')}`,
    );
  });

  it('adds no auth for a none scheme and returns non-2xx without throwing', async () => {
    const fetchImpl = fakeFetch(() => fakeResponse(404, 'nope', { 'content-type': 'text/plain' }));
    const t = new DirectTransport({ scheme: { type: 'none' }, credential: { type: 'none' }, fetchImpl });
    const res = await t.send(baseReq);
    expect(fetchImpl.calls[0]?.init?.headers?.['authorization']).toBeUndefined();
    expect(res).toEqual({ status: 404, headers: { 'content-type': 'text/plain' }, data: 'nope' });
  });

  it('runs a custom scheme apply()', async () => {
    const fetchImpl = fakeFetch(() => fakeResponse(200, '{}', { 'content-type': 'application/json' }));
    const scheme: AuthScheme = {
      type: 'custom',
      apply: (req, cred) => {
        if (cred.type === 'apiKey') req.headers['x-signature'] = `sig-${cred.value}`;
      },
    };
    const t = new DirectTransport({ scheme, credential: { type: 'apiKey', value: 'z' }, fetchImpl });
    await t.send(baseReq);
    expect(fetchImpl.calls[0]?.init?.headers?.['x-signature']).toBe('sig-z');
  });

  it('does not mutate the caller request object', async () => {
    const fetchImpl = fakeFetch(() => fakeResponse(200, '{}', { 'content-type': 'application/json' }));
    const t = new DirectTransport({
      scheme: { type: 'oauth2' },
      credential: { type: 'bearer', token: 'T' },
      fetchImpl,
    });
    const req: NormalizedRequest = { method: 'GET', url: 'https://api.test/x', headers: {} };
    await t.send(req);
    expect(req.headers).toEqual({});
  });
});
