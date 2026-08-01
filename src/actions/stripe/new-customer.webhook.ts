import { defineTrigger, type WebhookRegistration } from '../../core/trigger';
import { stripeAuth } from './common';
import {
  asStripeEvent,
  createStripeWebhookEndpoint,
  deleteStripeWebhookEndpoint,
  verifyStripeSignature,
} from './webhook-common';

/** Public type for the registered-webhook trigger. */
export const NEW_CUSTOMER_TYPE = 'stripe.new_customer';

/** The Stripe event this trigger subscribes to. */
const EVENT = 'customer.created';

/** The Customer resource carried in the event's `data.object` (the relevant fields). */
interface StripeCustomerObject {
  id?: string;
  email?: string | null;
  name?: string | null;
  description?: string | null;
}

/** A normalised new-customer event — what a workflow step receives. Trimmed to the fields workflows use. */
export interface StripeCustomerEvent {
  /** Stripe's event id (`evt_…`) — the delivery-dedup key. */
  eventId: string;
  /** The customer id (`cus_…`). */
  customerId: string;
  email?: string;
  name?: string;
  description?: string;
  /** Unix seconds the event was created. */
  created: number;
  livemode: boolean;
}

/** Registered webhook trigger for new Stripe customers — `onEnable` creates the endpoint, `onDisable` deletes it. */
export const newCustomer = defineTrigger({
  type: NEW_CUSTOMER_TYPE,
  strategy: 'webhook',
  name: 'New customer',
  description: 'Fires when a new Stripe customer is created.',
  auth: stripeAuth,
  props: {},
  sampleData: {
    eventId: 'evt_1NG8Du2eZvKYlo2CUI79vXWy',
    customerId: 'cus_NffrFeUfNV2Hib',
    email: 'jane@example.com',
    name: 'Jane Doe',
    description: 'Acquired via launch campaign',
    created: 1686089970,
    livemode: false,
  },
  /** Register a webhook endpoint subscribed to `customer.created`, pointed at the intake URL. */
  async onEnable({ http, auth, webhookUrl }): Promise<WebhookRegistration> {
    return createStripeWebhookEndpoint(http, auth, { event: EVENT, webhookUrl });
  },
  /** Delete the webhook endpoint. A 404 means it's already gone — teardown is idempotent. */
  async onDisable({ http, auth, registration }): Promise<void> {
    await deleteStripeWebhookEndpoint(http, auth, registration);
  },
  /** Authenticate the delivery with the endpoint's signing secret before trusting the payload. */
  verify: verifyStripeSignature,
  onRequest({ request }): StripeCustomerEvent[] {
    const event = asStripeEvent<StripeCustomerObject>(request.body, EVENT);
    if (!event) return [];
    const customer = event.data.object;
    if (typeof customer.id !== 'string') return [];
    return [
      {
        eventId: event.id,
        customerId: customer.id,
        ...(customer.email ? { email: customer.email } : {}),
        ...(customer.name ? { name: customer.name } : {}),
        ...(customer.description ? { description: customer.description } : {}),
        created: event.created,
        livemode: event.livemode,
      },
    ];
  },
  /** Stripe may redeliver the same event id — dedupe on it. */
  dedupeKey: (event) => event.eventId,
});
