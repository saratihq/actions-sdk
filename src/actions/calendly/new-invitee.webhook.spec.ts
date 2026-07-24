import type { NormalizedRequest, NormalizedResponse } from '../../core/http/types';
import type { WebhookRequest } from '../../core/trigger';
import { FakeTransport, stubAuth } from '../../testing/fakes';
import { MemoryStore } from '../../testing/memory-store';
import { type CalendlyInviteeEvent, newInvitee, signCalendlyBody } from './new-invitee.webhook';

const SECRET = 'calendly-signing-key';
const WEBHOOK_URL = 'https://runtime.example.com/api/hooks/cal-7';
const TIMESTAMP = '1690000000';
const USER_URI = 'https://api.calendly.com/users/UUUUUUUUUUUUUUUU';
const ORG_URI = 'https://api.calendly.com/organizations/OOOOOOOOOOOOOOOO';
const SUB_URI = 'https://api.calendly.com/webhook_subscriptions/SSSSSSSSSSSSSSSS';

function delivery(payload: unknown, secret = SECRET): WebhookRequest {
  const rawBody = JSON.stringify(payload);
  return {
    headers: { 'calendly-webhook-signature': signCalendlyBody(rawBody, TIMESTAMP, secret) },
    body: payload,
    rawBody,
  };
}

/**
 * An `invitee.created` webhook (shape from the public Calendly v2 webhook docs):
 * the invitee fields sit DIRECTLY on `payload`, with a nested `scheduled_event`.
 */
const INVITEE_PAYLOAD = {
  created_at: '2026-07-20T17:51:19.000000Z',
  event: 'invitee.created',
  payload: {
    uri: 'https://api.calendly.com/scheduled_events/EEEE/invitees/IIII',
    email: 'invitee@example.com',
    name: 'John Doe',
    status: 'active',
    timezone: 'America/New_York',
    event: 'https://api.calendly.com/scheduled_events/EEEE',
    cancel_url: 'https://calendly.com/cancellations/IIII',
    reschedule_url: 'https://calendly.com/reschedulings/IIII',
    questions_and_answers: [
      { question: 'What would you like to discuss?', answer: 'Onboarding', position: 0 },
    ],
    scheduled_event: {
      uri: 'https://api.calendly.com/scheduled_events/EEEE',
      name: '15 Minute Meeting',
      status: 'active',
      start_time: '2026-07-24T14:00:00.000000Z',
      end_time: '2026-07-24T14:15:00.000000Z',
    },
  },
};

describe('calendly.new_invitee — registration contract (onEnable/onDisable)', () => {
  it('onEnable resolves the user then subscribes to invitee.created with the signing key', async () => {
    // Call 0 → GET /users/me; call 1 → POST /webhook_subscriptions.
    const transport = new FakeTransport((_req: NormalizedRequest, index: number): NormalizedResponse => {
      if (index === 0) {
        return {
          status: 200,
          headers: {},
          data: { resource: { uri: USER_URI, current_organization: ORG_URI } },
        };
      }
      return { status: 201, headers: {}, data: { resource: { uri: SUB_URI } } };
    });

    const registration = await newInvitee.enable({
      auth: stubAuth(transport),
      props: {},
      store: new MemoryStore(),
      webhookUrl: WEBHOOK_URL,
      secret: SECRET,
    });

    expect(registration).toEqual({ subscriptionId: 'SSSSSSSSSSSSSSSS' });
    expect(transport.requests).toHaveLength(2);
    expect(transport.requests[0]?.url).toBe('https://api.calendly.com/users/me');
    const create = transport.requests[1];
    expect(create?.method).toBe('POST');
    expect(create?.url).toBe('https://api.calendly.com/webhook_subscriptions');
    expect(create?.body).toEqual({
      url: WEBHOOK_URL,
      events: ['invitee.created'],
      organization: ORG_URI,
      user: USER_URI,
      scope: 'user',
      signing_key: SECRET,
    });
  });

  it('onDisable deletes the subscription by its uuid', async () => {
    const transport = new FakeTransport((): NormalizedResponse => ({ status: 204, headers: {}, data: {} }));
    await newInvitee.disable({
      auth: stubAuth(transport),
      props: {},
      store: new MemoryStore(),
      webhookUrl: WEBHOOK_URL,
      secret: SECRET,
      registration: { subscriptionId: 'SSSSSSSSSSSSSSSS' },
    });
    const sent = transport.requests[0];
    expect(sent?.method).toBe('DELETE');
    expect(sent?.url).toBe('https://api.calendly.com/webhook_subscriptions/SSSSSSSSSSSSSSSS');
  });

  it('onDisable tolerates a 404 (subscription already gone)', async () => {
    const transport = new FakeTransport((): NormalizedResponse => ({ status: 404, headers: {}, data: {} }));
    await expect(
      newInvitee.disable({
        auth: stubAuth(transport),
        props: {},
        store: new MemoryStore(),
        webhookUrl: WEBHOOK_URL,
        secret: SECRET,
        registration: { subscriptionId: 'gone' },
      }),
    ).resolves.toBeUndefined();
  });
});

describe('calendly.new_invitee — inbound verification + transform', () => {
  const noNetwork = stubAuth(
    new FakeTransport(() => {
      throw new Error('intake must not call the network');
    }),
  );

  it('rejects a delivery whose signature does not match (spoofed)', async () => {
    await expect(
      newInvitee.handleRequest({
        auth: noNetwork,
        props: {},
        store: new MemoryStore(),
        request: delivery(INVITEE_PAYLOAD, 'the-attackers-key'),
        secrets: { signingSecret: SECRET },
      }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('transforms a signed invitee.created delivery into a normalised event', async () => {
    const events = await newInvitee.handleRequest({
      auth: noNetwork,
      props: {},
      store: new MemoryStore(),
      request: delivery(INVITEE_PAYLOAD),
      secrets: { signingSecret: SECRET },
    });
    expect(events).toEqual<CalendlyInviteeEvent[]>([
      {
        inviteeUri: 'https://api.calendly.com/scheduled_events/EEEE/invitees/IIII',
        email: 'invitee@example.com',
        name: 'John Doe',
        status: 'active',
        timezone: 'America/New_York',
        eventUri: 'https://api.calendly.com/scheduled_events/EEEE',
        eventName: '15 Minute Meeting',
        startTime: '2026-07-24T14:00:00.000000Z',
        endTime: '2026-07-24T14:15:00.000000Z',
        cancelUrl: 'https://calendly.com/cancellations/IIII',
        rescheduleUrl: 'https://calendly.com/reschedulings/IIII',
        questionsAndAnswers: [{ question: 'What would you like to discuss?', answer: 'Onboarding' }],
        createdAt: '2026-07-20T17:51:19.000000Z',
      },
    ]);
  });

  it('ignores an authentic delivery of a different event type', async () => {
    const canceled = { ...INVITEE_PAYLOAD, event: 'invitee.canceled' };
    const events = await newInvitee.handleRequest({
      auth: noNetwork,
      props: {},
      store: new MemoryStore(),
      request: delivery(canceled),
      secrets: { signingSecret: SECRET },
    });
    expect(events).toEqual([]);
  });

  it('dedupes a redelivered booking (same invitee URI fires once)', async () => {
    const store = new MemoryStore();
    const first = await newInvitee.handleRequest({
      auth: noNetwork,
      props: {},
      store,
      request: delivery(INVITEE_PAYLOAD),
      secrets: { signingSecret: SECRET },
    });
    const second = await newInvitee.handleRequest({
      auth: noNetwork,
      props: {},
      store,
      request: delivery(INVITEE_PAYLOAD),
      secrets: { signingSecret: SECRET },
    });
    expect(first).toHaveLength(1);
    expect(second).toEqual([]);
  });
});
