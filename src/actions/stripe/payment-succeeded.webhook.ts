import { defineTrigger, type WebhookRegistration } from '../../core/trigger';
import { stripeAuth } from './common';
import {
  asStripeEvent,
  createStripeWebhookEndpoint,
  deleteStripeWebhookEndpoint,
  verifyStripeSignature,
} from './webhook-common';

/** Public type for the registered-webhook trigger. */
export const PAYMENT_SUCCEEDED_TYPE = 'stripe.payment_succeeded';

/** The Stripe event this trigger subscribes to. */
const EVENT = 'charge.succeeded';

/** The Charge resource carried in the event's `data.object` (the relevant fields). */
interface StripeChargeObject {
  id?: string;
  amount?: number;
  currency?: string;
  status?: string;
  paid?: boolean;
  customer?: string | null;
  receipt_email?: string | null;
  payment_intent?: string | null;
}

/** A normalised successful-payment event; amounts stay in the currency's smallest unit, paired with `currency`. */
export interface StripePaymentEvent {
  /** Stripe's event id (`evt_…`) — the delivery-dedup key. */
  eventId: string;
  /** The charge id (`ch_…`). */
  chargeId: string;
  /** Amount in the currency's smallest unit (e.g. cents). */
  amount: number;
  currency: string;
  /** `succeeded` for this event. */
  status: string;
  paid: boolean;
  customer?: string;
  receiptEmail?: string;
  paymentIntent?: string;
  /** Unix seconds the event was created. */
  created: number;
  livemode: boolean;
}

/** Registered webhook trigger for Stripe successful charges — `onEnable` creates the endpoint, `onDisable` deletes it. */
export const paymentSucceeded = defineTrigger({
  type: PAYMENT_SUCCEEDED_TYPE,
  strategy: 'webhook',
  name: 'Payment succeeded',
  description: 'Fires when a Stripe charge succeeds.',
  auth: stripeAuth,
  props: {},
  sampleData: {
    eventId: 'evt_1NG8Du2eZvKYlo2CUI79vXWy',
    chargeId: 'ch_3NirD82eZvKYlo2C1qGabc12',
    amount: 2000,
    currency: 'usd',
    status: 'succeeded',
    paid: true,
    customer: 'cus_NffrFeUfNV2Hib',
    receiptEmail: 'jane@example.com',
    paymentIntent: 'pi_3NirD82eZvKYlo2C1abcDEF',
    created: 1686089970,
    livemode: false,
  },
  /** Register a webhook endpoint subscribed to `charge.succeeded`, pointed at the intake URL. */
  async onEnable({ http, auth, webhookUrl }): Promise<WebhookRegistration> {
    return createStripeWebhookEndpoint(http, auth, { event: EVENT, webhookUrl });
  },
  /** Delete the webhook endpoint. A 404 means it's already gone — teardown is idempotent. */
  async onDisable({ http, auth, registration }): Promise<void> {
    await deleteStripeWebhookEndpoint(http, auth, registration);
  },
  /** Authenticate the delivery with the endpoint's signing secret before trusting the payload. */
  verify: verifyStripeSignature,
  onRequest({ request }): StripePaymentEvent[] {
    const event = asStripeEvent<StripeChargeObject>(request.body, EVENT);
    if (!event) return [];
    const charge = event.data.object;
    if (typeof charge.id !== 'string') return [];
    return [
      {
        eventId: event.id,
        chargeId: charge.id,
        amount: charge.amount ?? 0,
        currency: charge.currency ?? '',
        status: charge.status ?? '',
        paid: charge.paid ?? false,
        ...(charge.customer ? { customer: charge.customer } : {}),
        ...(charge.receipt_email ? { receiptEmail: charge.receipt_email } : {}),
        ...(charge.payment_intent ? { paymentIntent: charge.payment_intent } : {}),
        created: event.created,
        livemode: event.livemode,
      },
    ];
  },
  /** Stripe may redeliver the same event id — dedupe on it. */
  dedupeKey: (event) => event.eventId,
});
