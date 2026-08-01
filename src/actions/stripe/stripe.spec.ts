import { HttpClient } from '../../core/http/client';
import type { NormalizedRequest, NormalizedResponse } from '../../core/http/types';
import { FakeTransport, stubAuth } from '../../testing/fakes';
import { getBalance, getCustomer, listCustomers, searchCustomers } from './reads';

function fake(handler: (req: NormalizedRequest) => NormalizedResponse) {
  const transport = new FakeTransport(handler);
  return { auth: stubAuth(transport, 'apiKey'), http: new HttpClient(), transport };
}

describe('stripe.get_customer', () => {
  it('retrieves by id', async () => {
    const customer = { id: 'cus_1', object: 'customer', email: 'jane@acme.com', name: 'Jane' };
    const { auth, http, transport } = fake(() => ({ status: 200, headers: {}, data: customer }));
    const out = await getCustomer.execute({ auth, http, props: { customerId: 'cus_1' } });
    expect(out.email).toBe('jane@acme.com');
    expect(transport.requests[0]!.url).toBe('https://api.stripe.com/v1/customers/cus_1');
  });
});

describe('stripe.list_customers', () => {
  it('passes limit + email and returns data/has_more', async () => {
    const { auth, http, transport } = fake(() => ({
      status: 200,
      headers: {},
      data: { object: 'list', data: [{ id: 'cus_1', object: 'customer' }], has_more: false },
    }));
    const out = await listCustomers.execute({ auth, http, props: { limit: 5, email: 'jane@acme.com' } });
    expect(out.has_more).toBe(false);
    expect(out.data).toHaveLength(1);
    const url = transport.requests[0]!.url;
    expect(url).toContain('limit=5');
    expect(url).toContain('email=jane%40acme.com');
  });
});

describe('stripe.search_customers', () => {
  it('hits the search endpoint with the query', async () => {
    const { auth, http, transport } = fake(() => ({
      status: 200,
      headers: {},
      data: { object: 'list', data: [], has_more: false, next_page: null },
    }));
    await searchCustomers.execute({ auth, http, props: { query: "email:'jane@acme.com'" } });
    const url = transport.requests[0]!.url;
    expect(url).toContain('https://api.stripe.com/v1/customers/search');
    expect(url).toContain('query=');
  });
});

describe('stripe.get_balance', () => {
  it('reads the balance endpoint', async () => {
    const { auth, http, transport } = fake(() => ({
      status: 200,
      headers: {},
      data: { object: 'balance', available: [{ amount: 1000, currency: 'usd' }], pending: [] },
    }));
    const out = await getBalance.execute({ auth, http, props: {} });
    expect(out.available[0]?.amount).toBe(1000);
    expect(transport.requests[0]!.url).toBe('https://api.stripe.com/v1/balance');
  });
});

describe('stripe customer picker', () => {
  it('maps name (email) and uses the search endpoint when a term is given', async () => {
    const { auth, http, transport } = fake(() => ({
      status: 200,
      headers: {},
      data: {
        object: 'list',
        data: [{ id: 'cus_1', object: 'customer', name: 'Jane', email: 'jane@acme.com' }],
        has_more: false,
      },
    }));
    const plain = await getCustomer.loadOptions('customerId', { auth, http });
    expect(plain.options[0]).toEqual({ label: 'Jane (jane@acme.com)', value: 'cus_1' });
    expect(transport.requests[0]!.url).toContain('/customers?');

    await getCustomer.loadOptions('customerId', { auth, http, search: 'jane' });
    expect(transport.requests[1]!.url).toContain('/customers/search');
  });

  it('is inert without a connection', async () => {
    const result = await getCustomer.loadOptions('customerId', {});
    expect(result.disabled).toBe(true);
  });
});
