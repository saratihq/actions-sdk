import type { CustomScheme, DirectCredential } from './auth';
import { createDirectAuth } from './auth-factories';
import { HttpClient } from './http/client';
import type { NormalizedRequest } from './http/types';
import { fakeFetch, fakeResponse } from '../testing/fakes';

function signRequest(req: NormalizedRequest, cred: DirectCredential): string {
  const sig = cred.type === 'apiKey' ? `sig-${cred.value}` : '';
  req.headers['x-sig'] = sig;
  return sig;
}

const SHAPES: Array<[string, CustomScheme]> = [
  [
    'a concise arrow returning the assigned value',
    {
      type: 'custom',
      origins: ['https://api.example.com'],
      apply: (req) => (req.headers['x-sig'] = 'sig-k'),
    },
  ],
  [
    'Object.assign',
    {
      type: 'custom',
      origins: ['https://api.example.com'],
      apply: (req) => Object.assign(req.headers, { 'x-sig': 'sig-k' }),
    },
  ],
  [
    'a named signing helper returning its signature',
    { type: 'custom', origins: ['https://api.example.com'], apply: signRequest },
  ],
  [
    'an async apply',
    {
      type: 'custom',
      origins: ['https://api.example.com'],
      apply: async (req) => {
        req.headers['x-sig'] = await Promise.resolve('sig-k');
      },
    },
  ],
];

describe('CustomScheme.apply accepts every shape a scheme author writes', () => {
  it.each(SHAPES)('%s type-checks and signs the request', async (_label, scheme) => {
    const fetchImpl = fakeFetch(() => fakeResponse(200, '{}', { 'content-type': 'application/json' }));
    await new HttpClient().get('https://api.example.com/x', {
      auth: createDirectAuth(scheme, { type: 'apiKey', value: 'k' }, { fetchImpl }),
    });
    expect(fetchImpl.calls[0]?.init?.headers?.['x-sig']).toBe('sig-k');
  });
});
