import { defineAction } from '../../core/action';
import { dropdown, number, shortText } from '../../core/props';
import { customerOptions, STRIPE_API_BASE, type StripeCustomer, type StripeList, stripeAuth } from './common';

/** Public types — stable public catalog ids. */
export const GET_CUSTOMER_TYPE = 'stripe.get_customer';
export const LIST_CUSTOMERS_TYPE = 'stripe.list_customers';
export const SEARCH_CUSTOMERS_TYPE = 'stripe.search_customers';
export const LIST_CHARGES_TYPE = 'stripe.list_charges';
export const LIST_SUBSCRIPTIONS_TYPE = 'stripe.list_subscriptions';
export const GET_BALANCE_TYPE = 'stripe.get_balance';

/** A Stripe charge, trimmed to the fields workflows read. */
export interface StripeCharge {
  id: string;
  object: 'charge';
  amount: number;
  currency: string;
  status: string;
  paid: boolean;
  customer?: string | null;
  created: number;
}

/** A Stripe subscription, trimmed to the fields workflows read. */
export interface StripeSubscription {
  id: string;
  object: 'subscription';
  status: string;
  customer: string;
  created: number;
  current_period_end?: number;
}

/** The `GET /balance` response — funds available and pending, per currency. */
export interface StripeBalance {
  object: 'balance';
  available: Array<{ amount: number; currency: string }>;
  pending: Array<{ amount: number; currency: string }>;
}

/** Retrieve a single customer by id. The customer picker is live (with search). */
export const getCustomer = defineAction({
  type: GET_CUSTOMER_TYPE,
  name: 'Get customer',
  description: 'Retrieve a Stripe customer by id.',
  auth: stripeAuth,
  props: {
    customerId: dropdown<string, true>({
      label: 'Customer',
      description: 'Loaded live from your account; type to search by name or email.',
      required: true,
      options: ({ auth, http, search }) => customerOptions(http, auth, search),
    }),
  },
  async run({ auth, props, http }): Promise<StripeCustomer> {
    const res = await http.get<StripeCustomer>(
      `${STRIPE_API_BASE}/customers/${encodeURIComponent(props.customerId)}`,
      { auth },
    );
    return res.data;
  },
});

/** List customers, most recent first. `startingAfter` (a customer id) pages forward. */
export const listCustomers = defineAction({
  type: LIST_CUSTOMERS_TYPE,
  name: 'List customers',
  description: 'List Stripe customers.',
  auth: stripeAuth,
  props: {
    limit: number({ label: 'Limit', description: '1–100.', required: false, defaultValue: 10 }),
    email: shortText({ label: 'Email', description: 'Filter to an exact email.', required: false }),
    startingAfter: shortText({
      label: 'Starting after',
      description: 'Customer id to page after.',
      required: false,
    }),
  },
  async run({ auth, props, http }): Promise<{ data: StripeCustomer[]; has_more: boolean }> {
    const res = await http.get<StripeList<StripeCustomer>>(`${STRIPE_API_BASE}/customers`, {
      auth,
      query: {
        limit: props.limit ?? 10,
        email: props.email,
        starting_after: props.startingAfter,
      },
    });
    return { data: res.data.data, has_more: res.data.has_more };
  },
});

/**
 * Search customers with Stripe's search query language, e.g.
 * `email:'jane@acme.com'` or `name~"acme"`. Returns one page.
 */
export const searchCustomers = defineAction({
  type: SEARCH_CUSTOMERS_TYPE,
  name: 'Search customers',
  description: 'Search Stripe customers with a query.',
  auth: stripeAuth,
  props: {
    query: shortText<true>({
      label: 'Query',
      description: `Stripe search syntax, e.g. email:'jane@acme.com' or name~"acme".`,
      required: true,
    }),
    limit: number({ label: 'Limit', required: false, defaultValue: 10 }),
    page: shortText({ label: 'Page', description: 'next_page token from a prior result.', required: false }),
  },
  async run({
    auth,
    props,
    http,
  }): Promise<{ data: StripeCustomer[]; has_more: boolean; next_page?: string | null }> {
    const res = await http.get<StripeList<StripeCustomer> & { next_page?: string | null }>(
      `${STRIPE_API_BASE}/customers/search`,
      { auth, query: { query: props.query, limit: props.limit ?? 10, page: props.page } },
    );
    return { data: res.data.data, has_more: res.data.has_more, next_page: res.data.next_page ?? null };
  },
});

/** List charges, most recent first, optionally scoped to a customer (live picker). */
export const listCharges = defineAction({
  type: LIST_CHARGES_TYPE,
  name: 'List charges',
  description: 'List Stripe charges.',
  auth: stripeAuth,
  props: {
    customerId: dropdown<string, false>({
      label: 'Customer',
      required: false,
      options: ({ auth, http, search }) => customerOptions(http, auth, search),
    }),
    limit: number({ label: 'Limit', required: false, defaultValue: 10 }),
    startingAfter: shortText({ label: 'Starting after', required: false }),
  },
  async run({ auth, props, http }): Promise<{ data: StripeCharge[]; has_more: boolean }> {
    const res = await http.get<StripeList<StripeCharge>>(`${STRIPE_API_BASE}/charges`, {
      auth,
      query: { customer: props.customerId, limit: props.limit ?? 10, starting_after: props.startingAfter },
    });
    return { data: res.data.data, has_more: res.data.has_more };
  },
});

/** List subscriptions, optionally by customer (live picker) and status. */
export const listSubscriptions = defineAction({
  type: LIST_SUBSCRIPTIONS_TYPE,
  name: 'List subscriptions',
  description: 'List Stripe subscriptions.',
  auth: stripeAuth,
  props: {
    customerId: dropdown<string, false>({
      label: 'Customer',
      required: false,
      options: ({ auth, http, search }) => customerOptions(http, auth, search),
    }),
    status: dropdown<string, false>({
      label: 'Status',
      required: false,
      options: [
        { label: 'Active', value: 'active' },
        { label: 'Past due', value: 'past_due' },
        { label: 'Canceled', value: 'canceled' },
        { label: 'All', value: 'all' },
      ],
    }),
    limit: number({ label: 'Limit', required: false, defaultValue: 10 }),
  },
  async run({ auth, props, http }): Promise<{ data: StripeSubscription[]; has_more: boolean }> {
    const res = await http.get<StripeList<StripeSubscription>>(`${STRIPE_API_BASE}/subscriptions`, {
      auth,
      query: { customer: props.customerId, status: props.status, limit: props.limit ?? 10 },
    });
    return { data: res.data.data, has_more: res.data.has_more };
  },
});

/** Retrieve the account balance. No inputs. */
export const getBalance = defineAction({
  type: GET_BALANCE_TYPE,
  name: 'Get balance',
  description: 'Retrieve the Stripe account balance.',
  auth: stripeAuth,
  props: {},
  async run({ auth, http }): Promise<StripeBalance> {
    const res = await http.get<StripeBalance>(`${STRIPE_API_BASE}/balance`, { auth });
    return res.data;
  },
});
