import { transportOf } from './auth';
import { createAuth, createDirectAuth } from './auth-factories';
import type { NormalizedResponse, Transport } from './http/types';

describe('auth handle opacity', () => {
  const handle = createDirectAuth({ type: 'oauth2' }, { type: 'bearer', token: 'SUPER_SECRET_TOKEN' });

  it('exposes only the scheme type on its public surface', () => {
    expect(Object.keys(handle)).toEqual(['scheme']);
    expect(handle.scheme).toBe('oauth2');
  });

  it('never serialises the credential or transport', () => {
    const serialised = JSON.stringify(handle);
    expect(serialised).toBe('{"scheme":"oauth2"}');
    expect(serialised).not.toContain('SUPER_SECRET_TOKEN');
  });

  it('yields its transport only via transportOf', () => {
    expect(transportOf(handle).kind).toBe('direct');
  });

  it('throws when a bare object masquerades as a handle', () => {
    expect(() => transportOf({ scheme: 'none' })).toThrow(/no transport/);
  });
});

describe('createAuth', () => {
  const fakeTransport: Transport = {
    kind: 'managed-proxy',
    send: (): Promise<NormalizedResponse> => Promise.resolve({ status: 200, headers: {}, data: null }),
  };

  it('wraps a host-supplied transport, labelling the handle with the scheme type', () => {
    const handle = createAuth({ type: 'oauth2' }, fakeTransport);
    expect(handle.scheme).toBe('oauth2');
    expect(transportOf(handle)).toBe(fakeTransport);
  });

  it('carries the declared scheme type through for a non-oauth scheme', () => {
    const handle = createAuth({ type: 'apiKey', in: 'header', name: 'Authorization' }, fakeTransport);
    expect(handle.scheme).toBe('apiKey');
  });
});
