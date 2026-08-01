import type { ApiKeyScheme, AuthHandle } from '../../core/auth';
import type { HttpClient } from '../../core/http/client';
import type { DropdownOption } from '../../core/props';

export const STRIPE_API_BASE = 'https://api.stripe.com/v1';

/** Stripe's secret key rides as a Bearer token; declared as an `apiKey` header scheme so both transports run identical action code. */
export const stripeAuth: ApiKeyScheme = {
  type: 'apiKey',
  in: 'header',
  name: 'Authorization',
  prefix: 'Bearer ',
};

/** Stripe's list envelope, generic over the resource. */
export interface StripeList<T> {
  object: 'list';
  data: T[];
  has_more: boolean;
  url?: string;
}

/** A Stripe customer, trimmed to the fields config and workflows use. */
export interface StripeCustomer {
  id: string;
  object: 'customer';
  email?: string | null;
  name?: string | null;
  description?: string | null;
  created?: number;
}

/** Live customer picker; a `search` term switches to Stripe's `customers/search` query syntax. */
export async function customerOptions(
  http: HttpClient,
  auth: AuthHandle,
  search?: string,
): Promise<DropdownOption<string>[]> {
  const url = search ? `${STRIPE_API_BASE}/customers/search` : `${STRIPE_API_BASE}/customers`;
  const query = search ? { query: `name~"${search}" OR email~"${search}"` } : { limit: 100 };
  const res = await http.get<StripeList<StripeCustomer>>(url, { auth, query });
  return res.data.data.map((customer) => ({
    label: `${customer.name ?? customer.id} (${customer.email ?? 'no email'})`,
    value: customer.id,
  }));
}
