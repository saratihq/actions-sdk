import { createHmac } from 'node:crypto';

import type { NormalizedRequest, NormalizedResponse } from '../../core/http/types';
import { HttpClient } from '../../core/http/client';
import type { WebhookRequest } from '../../core/trigger';
import { FakeTransport, stubAuth } from '../../testing/fakes';
import { MemoryStore } from '../../testing/memory-store';
import { type ClickupTaskEvent, newTask } from './new-task.webhook';

const SECRET = 'clickup_wh_provider_generated_secret';
const WEBHOOK_URL = 'https://runtime.example.com/api/hooks/cu-123';
const TEAM_ID = '9008';

/** Sign a raw body exactly as ClickUp would (`X-Signature` = hex HMAC-SHA256, no prefix). */
function sign(rawBody: string, secret = SECRET): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

/** A signed `taskCreated` delivery, as the runtime would hand it to the SDK. */
function delivery(payload: unknown, secret = SECRET): WebhookRequest {
  const rawBody = JSON.stringify(payload);
  return { headers: { 'x-signature': sign(rawBody, secret) }, body: payload, rawBody };
}

/** A real ClickUp `taskCreated` webhook payload (shape from the public docs). */
const TASK_PAYLOAD = {
  event: 'taskCreated',
  task_id: '9hz',
  webhook_id: '4b67ac88-2bb7-4b1a-8f0a-7c9f8e6d5c4b',
  history_items: [{ id: '1', type: 1, date: '1706107938084', field: 'status' }],
};

/** The task body ClickUp returns from GET /task/{id}, used to enrich the event. */
const TASK_BODY = {
  id: '9hz',
  name: 'Draft the launch checklist',
  status: { status: 'to do' },
  url: 'https://app.clickup.com/t/9hz',
};

describe('clickup.new_task — registration contract (onEnable/onDisable)', () => {
  it('onEnable creates a team webhook subscribed to taskCreated and persists the secret', async () => {
    const transport = new FakeTransport((): NormalizedResponse => ({
      status: 200,
      headers: {},
      data: { id: 'wh_top_5001', webhook: { id: 'wh_5001', secret: SECRET, endpoint: WEBHOOK_URL } },
    }));
    const store = new MemoryStore();
    const registration = await newTask.enable({
      auth: stubAuth(transport, 'apiKey'),
      props: { teamId: TEAM_ID, listId: '77' },
      store,
      webhookUrl: WEBHOOK_URL,
      secret: 'runtime-secret-ignored-by-clickup',
    });

    expect(registration).toEqual({ subscriptionId: 'wh_5001', signingSecret: SECRET });
    expect(store.snapshot().signingSecret).toBe(SECRET);

    const sent = transport.requests[0] as NormalizedRequest;
    expect(sent.method).toBe('POST');
    expect(sent.url).toBe('https://api.clickup.com/api/v2/team/9008/webhook');
    const body = sent.body as { endpoint: string; events: string[]; list_id?: string };
    expect(body.endpoint).toBe(WEBHOOK_URL);
    expect(body.events).toEqual(['taskCreated']);
    expect(body.list_id).toBe('77');
  });

  it('onDisable deletes exactly the webhook that onEnable created', async () => {
    const transport = new FakeTransport((): NormalizedResponse => ({ status: 200, headers: {}, data: {} }));
    await newTask.disable({
      auth: stubAuth(transport, 'apiKey'),
      props: { teamId: TEAM_ID },
      store: new MemoryStore(),
      webhookUrl: WEBHOOK_URL,
      secret: '',
      registration: { subscriptionId: 'wh_5001' },
    });
    const sent = transport.requests[0]!;
    expect(sent.method).toBe('DELETE');
    expect(sent.url).toBe('https://api.clickup.com/api/v2/webhook/wh_5001');
  });

  it('onDisable tolerates a 404 (hook already gone) — teardown is idempotent', async () => {
    const transport = new FakeTransport((): NormalizedResponse => ({
      status: 404,
      headers: {},
      data: { err: 'Webhook not found' },
    }));
    await expect(
      newTask.disable({
        auth: stubAuth(transport, 'apiKey'),
        props: { teamId: TEAM_ID },
        store: new MemoryStore(),
        webhookUrl: WEBHOOK_URL,
        secret: '',
        registration: { subscriptionId: 'wh_5001' },
      }),
    ).resolves.toBeUndefined();
  });
});

describe('clickup.new_task — inbound verification + transform', () => {
  /** A transport that answers only the GET /task/{id} enrichment call. */
  function taskFetchTransport(): FakeTransport {
    return new FakeTransport((req: NormalizedRequest): NormalizedResponse => {
      if (req.method === 'GET' && req.url.includes('/task/9hz')) {
        return { status: 200, headers: {}, data: TASK_BODY };
      }
      throw new Error(`unexpected request: ${req.method} ${req.url}`);
    });
  }

  /** Seed a store with the persisted signing secret (as onEnable would). */
  function seededStore(): MemoryStore {
    const store = new MemoryStore();
    void store.set('signingSecret', SECRET);
    return store;
  }

  it('rejects a delivery whose signature does not match (spoofed) without fetching', async () => {
    const transport = new FakeTransport(() => {
      throw new Error('must reject before any network call');
    });
    await expect(
      newTask.handleRequest({
        auth: stubAuth(transport, 'apiKey'),
        http: new HttpClient(),
        props: { teamId: TEAM_ID },
        store: seededStore(),
        request: delivery(TASK_PAYLOAD, 'the-attackers-secret'),
      }),
    ).rejects.toMatchObject({ status: 401 });
    expect(transport.requests).toHaveLength(0);
  });

  it('verifies, fetches the task, and transforms into a normalised event', async () => {
    const events = await newTask.handleRequest({
      auth: stubAuth(taskFetchTransport(), 'apiKey'),
      http: new HttpClient(),
      props: { teamId: TEAM_ID },
      store: seededStore(),
      request: delivery(TASK_PAYLOAD),
    });
    expect(events).toEqual<ClickupTaskEvent[]>([
      {
        event: 'taskCreated',
        taskId: '9hz',
        webhookId: '4b67ac88-2bb7-4b1a-8f0a-7c9f8e6d5c4b',
        name: 'Draft the launch checklist',
        status: 'to do',
        url: 'https://app.clickup.com/t/9hz',
      },
    ]);
  });

  it('still fires (id-only) when the enrichment fetch is unavailable', async () => {
    const transport = new FakeTransport((): NormalizedResponse => ({
      status: 500,
      headers: {},
      data: { err: 'boom' },
    }));
    const events = await newTask.handleRequest({
      auth: stubAuth(transport, 'apiKey'),
      http: new HttpClient({ retry: { retries: 0 } }),
      props: { teamId: TEAM_ID },
      store: seededStore(),
      request: delivery(TASK_PAYLOAD),
    });
    expect(events).toEqual<ClickupTaskEvent[]>([
      { event: 'taskCreated', taskId: '9hz', webhookId: '4b67ac88-2bb7-4b1a-8f0a-7c9f8e6d5c4b' },
    ]);
  });

  it('dedupes a redelivered taskCreated (same task fires once)', async () => {
    const store = seededStore();
    const first = await newTask.handleRequest({
      auth: stubAuth(taskFetchTransport(), 'apiKey'),
      http: new HttpClient(),
      props: { teamId: TEAM_ID },
      store,
      request: delivery(TASK_PAYLOAD),
    });
    const second = await newTask.handleRequest({
      auth: stubAuth(taskFetchTransport(), 'apiKey'),
      http: new HttpClient(),
      props: { teamId: TEAM_ID },
      store,
      request: delivery(TASK_PAYLOAD),
    });
    expect(first).toHaveLength(1);
    expect(second).toEqual([]);
  });
});
