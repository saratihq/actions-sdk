export { customerOptions, STRIPE_API_BASE, type StripeCustomer, type StripeList, stripeAuth } from './common';
export {
  GET_BALANCE_TYPE,
  GET_CUSTOMER_TYPE,
  getBalance,
  getCustomer,
  LIST_CHARGES_TYPE,
  LIST_CUSTOMERS_TYPE,
  LIST_SUBSCRIPTIONS_TYPE,
  listCharges,
  listCustomers,
  listSubscriptions,
  SEARCH_CUSTOMERS_TYPE,
  searchCustomers,
  type StripeBalance,
  type StripeCharge,
  type StripeSubscription,
} from './reads';

export { NEW_CUSTOMER_TYPE, newCustomer, type StripeCustomerEvent } from './new-customer.webhook';
export {
  PAYMENT_SUCCEEDED_TYPE,
  paymentSucceeded,
  type StripePaymentEvent,
} from './payment-succeeded.webhook';

import {
  getBalance,
  getCustomer,
  listCharges,
  listCustomers,
  listSubscriptions,
  searchCustomers,
} from './reads';

/** Every Stripe action, for catalog builds and registration. Read verbs only (writes need form-body encoding). */
export const stripeActions = [
  getCustomer,
  listCustomers,
  searchCustomers,
  listCharges,
  listSubscriptions,
  getBalance,
] as const;
