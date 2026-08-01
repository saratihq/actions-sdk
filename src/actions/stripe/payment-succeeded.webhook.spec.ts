import type { NormalizedResponse } from '../../core/http/types';
import { isFormBody } from '../../core/http/types';
import type { WebhookRequest } from '../../core/trigger';
import { FakeTransport, stubAuth } from '../../testing/fakes';
import { MemoryStore } from '../../testing/memory-store';
import { paymentSucceeded, type StripePaymentEvent } from './payment-succeeded.webhook';
import { signStripeBody } from './webhook-common';

const SECRET = 'whsec_wRNftLajMZNeslQOP6vEPm4iVx5NlZ6z';
const WEBHOOK_URL = 'https://runtime.example.com/api/hooks/abc-123';
const TIMESTAMP = '1686089970';

/** A signed inbound delivery, exactly as the runtime would hand it to the SDK. */
function delivery(payload: unknown, secret = SECRET): WebhookRequest {
  const rawBody = JSON.stringify(payload);
  return {
    headers: { 'stripe-signature': signStripeBody(rawBody, TIMESTAMP, secret) },
    body: payload,
    rawBody,
  };
}

/** A Stripe `charge.succeeded` event; `data.object` is the full charge resource. */
const CHARGE_EVENT = {
  id: 'evt_1NG8Du2eZvKYlo2CUI79vXWy',
  object: 'event',
  type: 'charge.succeeded',
  created: 1686089970,
  livemode: false,
  data: {
    object: {
      id: 'ch_3NirD82eZvKYlo2C1qGabc12',
      object: 'charge',
      amount: 2000,
      currency: 'usd',
      status: 'succeeded',
      paid: true,
      customer: 'cus_NffrFeUfNV2Hib',
      receipt_email: 'jane@example.com',
      payment_intent: 'pi_3NirD82eZvKYlo2C1abcDEF',
    },
  },
};

describe('stripe.payment_succeeded — registration contract (onEnable/onDisable)', () => {
  it('onEnable creates a webhook endpoint subscribed to charge.succeeded and captures the whsec secret', async () => {
    const transport = new FakeTransport((): NormalizedResponse => ({
      status: 201,
      headers: {},
      data: { id: 'we_1MqvVQ2eZvKYlo2C', secret: SECRET },
    }));
    const registration = await paymentSucceeded.enable({
      auth: stubAuth(transport),
      props: {},
      store: new MemoryStore(),
      webhookUrl: WEBHOOK_URL,
      secret: 'runtime-generated-unused-for-stripe',
    });

    // Stripe generates the secret; it is persisted for verify.
    expect(registration).toEqual({ subscriptionId: 'we_1MqvVQ2eZvKYlo2C', signingSecret: SECRET });
    expect(transport.requests).toHaveLength(1);
    const sent = transport.requests[0];
    expect(sent?.method).toBe('POST');
    expect(sent?.url).toBe('https://api.stripe.com/v1/webhook_endpoints');
    // The body is form-encoded (Stripe takes no JSON), url + the subscribed event.
    expect(isFormBody(sent?.body)).toBe(true);
    if (!isFormBody(sent?.body)) throw new Error('expected a form body');
    expect(sent.body.fields).toEqual([
      ['url', WEBHOOK_URL],
      ['enabled_events[0]', 'charge.succeeded'],
    ]);
  });

  it('onDisable deletes exactly the endpoint that onEnable created', async () => {
    const transport = new FakeTransport((): NormalizedResponse => ({ status: 200, headers: {}, data: {} }));
    await paymentSucceeded.disable({
      auth: stubAuth(transport),
      props: {},
      store: new MemoryStore(),
      webhookUrl: WEBHOOK_URL,
      secret: '',
      registration: { subscriptionId: 'we_1MqvVQ2eZvKYlo2C', signingSecret: SECRET },
    });
    expect(transport.requests).toHaveLength(1);
    const sent = transport.requests[0];
    expect(sent?.method).toBe('DELETE');
    expect(sent?.url).toBe('https://api.stripe.com/v1/webhook_endpoints/we_1MqvVQ2eZvKYlo2C');
  });

  it('onDisable tolerates a 404 (endpoint already gone) — teardown is idempotent', async () => {
    const transport = new FakeTransport((): NormalizedResponse => ({
      status: 404,
      headers: {},
      data: { error: { message: 'No such webhook endpoint' } },
    }));
    await expect(
      paymentSucceeded.disable({
        auth: stubAuth(transport),
        props: {},
        store: new MemoryStore(),
        webhookUrl: WEBHOOK_URL,
        secret: '',
        registration: { subscriptionId: 'we_gone', signingSecret: SECRET },
      }),
    ).resolves.toBeUndefined();
  });
});

describe('stripe.payment_succeeded — inbound verification + transform', () => {
  const noNetwork = stubAuth(
    new FakeTransport(() => {
      throw new Error('intake must not call the network');
    }),
  );

  it('rejects a delivery whose signature does not match (spoofed)', async () => {
    await expect(
      paymentSucceeded.handleRequest({
        auth: noNetwork,
        props: {},
        store: new MemoryStore(),
        request: delivery(CHARGE_EVENT, 'whsec_the-attackers-secret'),
        secrets: { signingSecret: SECRET },
      }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('transforms a signed charge.succeeded delivery into a normalised event', async () => {
    const events = await paymentSucceeded.handleRequest({
      auth: noNetwork,
      props: {},
      store: new MemoryStore(),
      request: delivery(CHARGE_EVENT),
      secrets: { signingSecret: SECRET },
    });
    expect(events).toEqual<StripePaymentEvent[]>([
      {
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
    ]);
  });

  it('ignores an authentic delivery of a different event type', async () => {
    const other = { ...CHARGE_EVENT, type: 'charge.refunded' };
    const events = await paymentSucceeded.handleRequest({
      auth: noNetwork,
      props: {},
      store: new MemoryStore(),
      request: delivery(other),
      secrets: { signingSecret: SECRET },
    });
    expect(events).toEqual([]);
  });

  it('dedupes a redelivered event (same evt_ id fires once)', async () => {
    const store = new MemoryStore();
    const first = await paymentSucceeded.handleRequest({
      auth: noNetwork,
      props: {},
      store,
      request: delivery(CHARGE_EVENT),
      secrets: { signingSecret: SECRET },
    });
    const second = await paymentSucceeded.handleRequest({
      auth: noNetwork,
      props: {},
      store,
      request: delivery(CHARGE_EVENT),
      secrets: { signingSecret: SECRET },
    });
    expect(first).toHaveLength(1);
    expect(second).toEqual([]);
  });
});
