import type { NormalizedResponse } from '../../core/http/types';
import { isFormBody } from '../../core/http/types';
import type { WebhookRequest } from '../../core/trigger';
import { FakeTransport, stubAuth } from '../../testing/fakes';
import { MemoryStore } from '../../testing/memory-store';
import { newCustomer, type StripeCustomerEvent } from './new-customer.webhook';
import { signStripeBody } from './webhook-common';

const SECRET = 'whsec_wRNftLajMZNeslQOP6vEPm4iVx5NlZ6z';
const WEBHOOK_URL = 'https://runtime.example.com/api/hooks/cust-1';
const TIMESTAMP = '1686089970';

function delivery(payload: unknown, secret = SECRET): WebhookRequest {
  const rawBody = JSON.stringify(payload);
  return {
    headers: { 'stripe-signature': signStripeBody(rawBody, TIMESTAMP, secret) },
    body: payload,
    rawBody,
  };
}

/** A Stripe `customer.created` event (shape from the public docs). */
const CUSTOMER_EVENT = {
  id: 'evt_1NG8Du2eZvKYlo2CUI79vXWy',
  object: 'event',
  type: 'customer.created',
  created: 1686089970,
  livemode: false,
  data: {
    object: {
      id: 'cus_NffrFeUfNV2Hib',
      object: 'customer',
      email: 'jane@example.com',
      name: 'Jane Doe',
      description: 'Acquired via launch campaign',
    },
  },
};

describe('stripe.new_customer — registration contract', () => {
  it('onEnable creates a webhook endpoint subscribed to customer.created and captures the secret', async () => {
    const transport = new FakeTransport((): NormalizedResponse => ({
      status: 201,
      headers: {},
      data: { id: 'we_cust1', secret: SECRET },
    }));
    const registration = await newCustomer.enable({
      auth: stubAuth(transport),
      props: {},
      store: new MemoryStore(),
      webhookUrl: WEBHOOK_URL,
      secret: 'unused',
    });
    expect(registration).toEqual({ subscriptionId: 'we_cust1', signingSecret: SECRET });
    const sent = transport.requests[0];
    expect(sent?.url).toBe('https://api.stripe.com/v1/webhook_endpoints');
    if (!isFormBody(sent?.body)) throw new Error('expected a form body');
    expect(sent.body.fields).toEqual([
      ['url', WEBHOOK_URL],
      ['enabled_events[0]', 'customer.created'],
    ]);
  });
});

describe('stripe.new_customer — inbound verification + transform', () => {
  const noNetwork = stubAuth(
    new FakeTransport(() => {
      throw new Error('intake must not call the network');
    }),
  );

  it('rejects a spoofed signature', async () => {
    await expect(
      newCustomer.handleRequest({
        auth: noNetwork,
        props: {},
        store: new MemoryStore(),
        request: delivery(CUSTOMER_EVENT, 'whsec_attacker'),
        secrets: { signingSecret: SECRET },
      }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('transforms a signed customer.created delivery into a normalised event', async () => {
    const events = await newCustomer.handleRequest({
      auth: noNetwork,
      props: {},
      store: new MemoryStore(),
      request: delivery(CUSTOMER_EVENT),
      secrets: { signingSecret: SECRET },
    });
    expect(events).toEqual<StripeCustomerEvent[]>([
      {
        eventId: 'evt_1NG8Du2eZvKYlo2CUI79vXWy',
        customerId: 'cus_NffrFeUfNV2Hib',
        email: 'jane@example.com',
        name: 'Jane Doe',
        description: 'Acquired via launch campaign',
        created: 1686089970,
        livemode: false,
      },
    ]);
  });

  it('dedupes a redelivered event', async () => {
    const store = new MemoryStore();
    const first = await newCustomer.handleRequest({
      auth: noNetwork,
      props: {},
      store,
      request: delivery(CUSTOMER_EVENT),
      secrets: { signingSecret: SECRET },
    });
    const second = await newCustomer.handleRequest({
      auth: noNetwork,
      props: {},
      store,
      request: delivery(CUSTOMER_EVENT),
      secrets: { signingSecret: SECRET },
    });
    expect(first).toHaveLength(1);
    expect(second).toEqual([]);
  });
});
