import { createHmac } from 'node:crypto';

import type { NormalizedResponse } from '../../core/http/types';
import type { WebhookRequest } from '../../core/trigger';
import { FakeTransport, stubAuth } from '../../testing/fakes';
import { MemoryStore } from '../../testing/memory-store';
import { newResponse, tagForWebhookUrl, type TypeformResponseEvent } from './new-response.webhook';

const SECRET = 'per-trigger-signing-secret';
const WEBHOOK_URL = 'https://runtime.example.com/api/hooks/tf-42';
const FORM_ID = 'u6nXL7';
const PROPS = { formId: FORM_ID };

/** Typeform signs the raw body with base64 HMAC-SHA256 under the `sha256=` prefix. */
function signTypeform(rawBody: string, secret = SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(rawBody).digest('base64')}`;
}

function delivery(payload: unknown, secret = SECRET): WebhookRequest {
  const rawBody = JSON.stringify(payload);
  return {
    headers: { 'typeform-signature': signTypeform(rawBody, secret) },
    body: payload,
    rawBody,
  };
}

/**
 * A Typeform `form_response` webhook payload (shape from the public example-payload
 * docs). The answers array carries only answered questions.
 */
const RESPONSE_PAYLOAD = {
  event_id: '01HZX8P7Q9J8N6M5K4T3R2W1V0',
  event_type: 'form_response',
  form_response: {
    form_id: FORM_ID,
    token: 'a3a9c2f0b1e24d6f8c7b5a4e3d2c1b0a',
    submitted_at: '2026-07-18T18:17:02Z',
    landed_at: '2026-07-18T18:16:20Z',
    definition: { id: FORM_ID, title: 'Customer feedback' },
    hidden: { utm_source: 'newsletter' },
    answers: [
      { type: 'text', text: 'Ada Lovelace', field: { id: 'abc123', ref: 'name', type: 'short_text' } },
      { type: 'email', email: 'ada@example.com', field: { id: 'def456', ref: 'email', type: 'email' } },
      { type: 'number', number: 9, field: { id: 'ghi789', ref: 'rating', type: 'number' } },
      {
        type: 'choices',
        choices: { labels: ['Docs', 'Support'] },
        field: { id: 'jkl012', ref: 'liked', type: 'multiple_choice' },
      },
    ],
  },
};

describe('typeform.new_response — registration contract (onEnable/onDisable)', () => {
  it('onEnable upserts a webhook (PUT) for the form under a stable tag, signed with the secret', async () => {
    const tag = tagForWebhookUrl(WEBHOOK_URL);
    const transport = new FakeTransport((): NormalizedResponse => ({
      status: 200,
      headers: {},
      data: { id: 'wh_1', tag, form_id: FORM_ID, enabled: true },
    }));
    const registration = await newResponse.enable({
      auth: stubAuth(transport),
      props: PROPS,
      store: new MemoryStore(),
      webhookUrl: WEBHOOK_URL,
      secret: SECRET,
    });

    expect(registration).toEqual({ subscriptionId: tag, formId: FORM_ID });
    const sent = transport.requests[0];
    expect(sent?.method).toBe('PUT');
    expect(sent?.url).toBe(`https://api.typeform.com/forms/${FORM_ID}/webhooks/${tag}`);
    expect(sent?.body).toEqual({ url: WEBHOOK_URL, enabled: true, secret: SECRET, verify_ssl: true });
  });

  it('onDisable deletes the webhook by its tag', async () => {
    const tag = tagForWebhookUrl(WEBHOOK_URL);
    const transport = new FakeTransport((): NormalizedResponse => ({ status: 204, headers: {}, data: {} }));
    await newResponse.disable({
      auth: stubAuth(transport),
      props: PROPS,
      store: new MemoryStore(),
      webhookUrl: WEBHOOK_URL,
      secret: SECRET,
      registration: { subscriptionId: tag, formId: FORM_ID },
    });
    const sent = transport.requests[0];
    expect(sent?.method).toBe('DELETE');
    expect(sent?.url).toBe(`https://api.typeform.com/forms/${FORM_ID}/webhooks/${tag}`);
  });

  it('onDisable tolerates a 404 (webhook already gone)', async () => {
    const transport = new FakeTransport((): NormalizedResponse => ({ status: 404, headers: {}, data: {} }));
    await expect(
      newResponse.disable({
        auth: stubAuth(transport),
        props: PROPS,
        store: new MemoryStore(),
        webhookUrl: WEBHOOK_URL,
        secret: SECRET,
        registration: { subscriptionId: tagForWebhookUrl(WEBHOOK_URL), formId: FORM_ID },
      }),
    ).resolves.toBeUndefined();
  });
});

describe('typeform.new_response — inbound verification + transform', () => {
  const noNetwork = stubAuth(
    new FakeTransport(() => {
      throw new Error('intake must not call the network');
    }),
  );

  it('rejects a delivery whose signature does not match (spoofed)', async () => {
    await expect(
      newResponse.handleRequest({
        auth: noNetwork,
        props: PROPS,
        store: new MemoryStore(),
        request: delivery(RESPONSE_PAYLOAD, 'the-attackers-secret'),
        secrets: { signingSecret: SECRET },
      }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('transforms a signed form_response delivery into a normalised event', async () => {
    const events = await newResponse.handleRequest({
      auth: noNetwork,
      props: PROPS,
      store: new MemoryStore(),
      request: delivery(RESPONSE_PAYLOAD),
      secrets: { signingSecret: SECRET },
    });
    expect(events).toEqual<TypeformResponseEvent[]>([
      {
        eventId: '01HZX8P7Q9J8N6M5K4T3R2W1V0',
        formId: FORM_ID,
        formTitle: 'Customer feedback',
        token: 'a3a9c2f0b1e24d6f8c7b5a4e3d2c1b0a',
        submittedAt: '2026-07-18T18:17:02Z',
        landedAt: '2026-07-18T18:16:20Z',
        hidden: { utm_source: 'newsletter' },
        answers: [
          { fieldId: 'abc123', fieldRef: 'name', type: 'text', value: 'Ada Lovelace' },
          { fieldId: 'def456', fieldRef: 'email', type: 'email', value: 'ada@example.com' },
          { fieldId: 'ghi789', fieldRef: 'rating', type: 'number', value: 9 },
          { fieldId: 'jkl012', fieldRef: 'liked', type: 'choices', value: ['Docs', 'Support'] },
        ],
      },
    ]);
  });

  it('dedupes a redelivered response (same event_id fires once)', async () => {
    const store = new MemoryStore();
    const first = await newResponse.handleRequest({
      auth: noNetwork,
      props: PROPS,
      store,
      request: delivery(RESPONSE_PAYLOAD),
      secrets: { signingSecret: SECRET },
    });
    const second = await newResponse.handleRequest({
      auth: noNetwork,
      props: PROPS,
      store,
      request: delivery(RESPONSE_PAYLOAD),
      secrets: { signingSecret: SECRET },
    });
    expect(first).toHaveLength(1);
    expect(second).toEqual([]);
  });
});
