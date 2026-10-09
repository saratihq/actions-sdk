import { HttpClient } from './client';
import { buildForm, encodeForm } from './form';
import { DirectTransport } from './transport-direct';
import { FORM, isFormBody } from './types';
import { createAuthHandle } from '../auth';
import { fakeFetch, fakeResponse } from '../../testing/fakes';

/** The `application/x-www-form-urlencoded` body rail: build/encode split, then a real url-encoded body on the wire. */
describe('buildForm', () => {
  it('flattens scalars and drops null/undefined, preserving order', () => {
    const body = buildForm({
      url: 'https://x/y',
      description: 'hi',
      skip: undefined,
      blank: null,
      n: 3,
      b: true,
    });
    expect(isFormBody(body)).toBe(true);
    expect(body.fields).toEqual([
      ['url', 'https://x/y'],
      ['description', 'hi'],
      ['n', '3'],
      ['b', 'true'],
    ]);
  });

  it('expands an array to bracket-indexed keys (Stripe repeated-param shape)', () => {
    const body = buildForm({ enabled_events: ['payment_intent.succeeded', 'customer.created'] });
    expect(body.fields).toEqual([
      ['enabled_events[0]', 'payment_intent.succeeded'],
      ['enabled_events[1]', 'customer.created'],
    ]);
  });
});

describe('encodeForm', () => {
  it('percent-encodes both sides and joins with &', () => {
    const encoded = encodeForm(buildForm({ url: 'https://x/y?a=1&b=2', 'enabled_events[0]': 'a.b' }));
    expect(encoded).toBe('url=https%3A%2F%2Fx%2Fy%3Fa%3D1%26b%3D2&enabled_events%5B0%5D=a.b');
  });

  it('is forgery-proof — a plain object is not a FormBody', () => {
    expect(isFormBody({ fields: [] })).toBe(false);
    expect(isFormBody({ [FORM]: true, fields: [] })).toBe(true);
  });
});

describe('DirectTransport form encoding', () => {
  it('sends a url-encoded body with the form content-type', async () => {
    const fetch = fakeFetch(() =>
      fakeResponse(200, JSON.stringify({ ok: true }), { 'content-type': 'application/json' }),
    );
    const client = new HttpClient();
    const transport = new DirectTransport({
      scheme: {
        type: 'apiKey',
        origins: ['https://api.stripe.com'],
        in: 'header',
        name: 'Authorization',
        prefix: 'Bearer ',
      },
      credential: { type: 'apiKey', value: 'sk_test' },
      fetchImpl: fetch,
    });
    const auth = createAuthHandle('apiKey', transport);

    await client.post('https://api.stripe.com/v1/webhook_endpoints', {
      auth,
      form: { url: 'https://x/hook', enabled_events: ['payment_intent.succeeded'] },
    });

    const call = fetch.calls[0];
    expect(call?.init?.body).toBe(
      'url=https%3A%2F%2Fx%2Fhook&enabled_events%5B0%5D=payment_intent.succeeded',
    );
    expect(call?.init?.headers?.['content-type']).toBe('application/x-www-form-urlencoded');
    // The credential still rode as a Bearer header — form encoding is orthogonal to auth.
    expect(call?.init?.headers?.['authorization']).toBe('Bearer sk_test');
  });
});

describe('client body mutual-exclusion', () => {
  it('rejects passing more than one of body/multipart/form', async () => {
    const fetch = fakeFetch(() => fakeResponse(200, '{}'));
    const client = new HttpClient();
    const transport = new DirectTransport({
      scheme: { type: 'none' },
      credential: { type: 'none' },
      fetchImpl: fetch,
    });
    const auth = createAuthHandle('none', transport);
    await expect(client.post('https://x/y', { auth, body: { a: 1 }, form: { b: 2 } })).rejects.toThrow(
      /exactly one of/,
    );
  });
});
