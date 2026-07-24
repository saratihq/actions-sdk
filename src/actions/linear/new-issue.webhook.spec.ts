import { createHmac } from 'node:crypto';

import type { NormalizedRequest, NormalizedResponse } from '../../core/http/types';
import type { WebhookRequest } from '../../core/trigger';
import { FakeTransport, stubAuth } from '../../testing/fakes';
import { MemoryStore } from '../../testing/memory-store';
import { type LinearIssueEvent, newIssue } from './new-issue.webhook';

const SECRET = 'lin_wh_provider_generated_secret';
const WEBHOOK_URL = 'https://runtime.example.com/api/hooks/lin-123';

/** Sign a raw body exactly as Linear would (`Linear-Signature` = hex HMAC-SHA256). */
function sign(rawBody: string, secret = SECRET): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

/** A signed inbound delivery, exactly as the runtime would hand it to the SDK. */
function delivery(payload: unknown, secret = SECRET): WebhookRequest {
  const rawBody = JSON.stringify(payload);
  return { headers: { 'linear-signature': sign(rawBody, secret) }, body: payload, rawBody };
}

/** A real Linear `Issue` create webhook payload (shape from the public docs). */
const ISSUE_PAYLOAD = {
  action: 'create',
  type: 'Issue',
  createdAt: '2025-01-24T14:32:18.084Z',
  organizationId: 'dc844923-f9a4-40a3-825c-dea7747e57d6',
  webhookTimestamp: 1706107938084,
  webhookId: '000042e3-d123-4980-b49f-8e140eef9329',
  url: 'https://linear.app/company/issue/ENG-123',
  actor: { id: 'b5ea5f1f-8adc-4f52-b4bd-ab4e84cf51ba', type: 'user', name: 'Sarah Chen' },
  data: {
    id: '8f7e6d5c-4b3a-2198-7f6e-5d4c3b2a1098',
    title: 'Add user authentication to API endpoints',
    number: 123,
    priority: 1,
    teamId: '72b2a2dc-6f4f-4423-9d34-24b5bd10634a',
    stateId: 'e3d2c1b0-a987-6f5e-4d3c-2b1a09876543',
    url: 'https://linear.app/company/issue/ENG-123',
  },
};

describe('linear.new_issue — registration contract (onEnable/onDisable)', () => {
  it('onEnable creates an Issue webhook at the URL and persists the provider secret', async () => {
    const transport = new FakeTransport((): NormalizedResponse => ({
      status: 200,
      headers: {},
      data: {
        data: { webhookCreate: { success: true, webhook: { id: 'wh_9001', enabled: true, secret: SECRET } } },
      },
    }));
    const store = new MemoryStore();
    const registration = await newIssue.enable({
      auth: stubAuth(transport, 'apiKey'),
      props: { teamId: 'team_1' },
      store,
      webhookUrl: WEBHOOK_URL,
      secret: 'runtime-secret-ignored-by-linear',
    });

    expect(registration).toEqual({ subscriptionId: 'wh_9001', signingSecret: SECRET });
    // The provider secret is persisted for the intake path to verify against.
    expect(store.snapshot().signingSecret).toBe(SECRET);

    const sent = transport.requests[0] as NormalizedRequest;
    expect(sent.url).toBe('https://api.linear.app/graphql');
    const input = (sent.body as { variables: { input: Record<string, unknown> } }).variables.input;
    expect(input.url).toBe(WEBHOOK_URL);
    expect(input.resourceTypes).toEqual(['Issue']);
    expect(input.teamId).toBe('team_1');
    expect(input.allPublicTeams).toBeUndefined();
  });

  it('onEnable falls back to allPublicTeams when no team is chosen', async () => {
    const transport = new FakeTransport((): NormalizedResponse => ({
      status: 200,
      headers: {},
      data: {
        data: { webhookCreate: { success: true, webhook: { id: 'wh_9002', enabled: true, secret: SECRET } } },
      },
    }));
    await newIssue.enable({
      auth: stubAuth(transport, 'apiKey'),
      props: {},
      store: new MemoryStore(),
      webhookUrl: WEBHOOK_URL,
      secret: '',
    });
    const input = (transport.requests[0]!.body as { variables: { input: Record<string, unknown> } }).variables
      .input;
    expect(input.allPublicTeams).toBe(true);
    expect(input.teamId).toBeUndefined();
  });

  it('onDisable deletes exactly the webhook that onEnable created', async () => {
    const transport = new FakeTransport((): NormalizedResponse => ({
      status: 200,
      headers: {},
      data: { data: { webhookDelete: { success: true } } },
    }));
    await newIssue.disable({
      auth: stubAuth(transport, 'apiKey'),
      props: {},
      store: new MemoryStore(),
      webhookUrl: WEBHOOK_URL,
      secret: '',
      registration: { subscriptionId: 'wh_9001', signingSecret: SECRET },
    });
    const sent = transport.requests[0]!;
    expect((sent.body as { variables: { id: string } }).variables.id).toBe('wh_9001');
    expect((sent.body as { query: string }).query).toContain('webhookDelete');
  });

  it('onDisable swallows a provider error (already gone) — teardown is idempotent', async () => {
    const transport = new FakeTransport((): NormalizedResponse => ({
      status: 200,
      headers: {},
      data: { errors: [{ message: 'Entity not found' }] },
    }));
    await expect(
      newIssue.disable({
        auth: stubAuth(transport, 'apiKey'),
        props: {},
        store: new MemoryStore(),
        webhookUrl: WEBHOOK_URL,
        secret: '',
        registration: { subscriptionId: 'wh_9001' },
      }),
    ).resolves.toBeUndefined();
  });
});

describe('linear.new_issue — inbound verification + transform', () => {
  // A throwing transport proves the intake path never calls the network.
  const noNetwork = stubAuth(
    new FakeTransport(() => {
      throw new Error('intake must not call the network');
    }),
    'apiKey',
  );

  /** Seed a store with the persisted signing secret (as onEnable would). */
  function seededStore(): MemoryStore {
    const store = new MemoryStore();
    void store.set('signingSecret', SECRET);
    return store;
  }

  it('rejects a delivery whose signature does not match (spoofed)', async () => {
    await expect(
      newIssue.handleRequest({
        auth: noNetwork,
        props: {},
        store: seededStore(),
        request: delivery(ISSUE_PAYLOAD, 'the-attackers-secret'),
      }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('rejects when no secret has been persisted (fail closed)', async () => {
    await expect(
      newIssue.handleRequest({
        auth: noNetwork,
        props: {},
        store: new MemoryStore(),
        request: delivery(ISSUE_PAYLOAD),
      }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('transforms a signed Issue delivery into a normalised event', async () => {
    const events = await newIssue.handleRequest({
      auth: noNetwork,
      props: {},
      store: seededStore(),
      request: delivery(ISSUE_PAYLOAD),
    });
    expect(events).toEqual<LinearIssueEvent[]>([
      {
        action: 'create',
        issueId: '8f7e6d5c-4b3a-2198-7f6e-5d4c3b2a1098',
        title: 'Add user authentication to API endpoints',
        url: 'https://linear.app/company/issue/ENG-123',
        number: 123,
        priority: 1,
        teamId: '72b2a2dc-6f4f-4423-9d34-24b5bd10634a',
        stateId: 'e3d2c1b0-a987-6f5e-4d3c-2b1a09876543',
        actor: 'Sarah Chen',
        webhookTimestamp: 1706107938084,
      },
    ]);
  });

  it('ignores a signed delivery for a non-Issue resource', async () => {
    const events = await newIssue.handleRequest({
      auth: noNetwork,
      props: {},
      store: seededStore(),
      request: delivery({ ...ISSUE_PAYLOAD, type: 'Comment' }),
    });
    expect(events).toEqual([]);
  });

  it('dedupes a redelivered event (same issue/action/timestamp fires once)', async () => {
    const store = seededStore();
    const first = await newIssue.handleRequest({
      auth: noNetwork,
      props: {},
      store,
      request: delivery(ISSUE_PAYLOAD),
    });
    const second = await newIssue.handleRequest({
      auth: noNetwork,
      props: {},
      store,
      request: delivery(ISSUE_PAYLOAD),
    });
    expect(first).toHaveLength(1);
    expect(second).toEqual([]);
  });
});
