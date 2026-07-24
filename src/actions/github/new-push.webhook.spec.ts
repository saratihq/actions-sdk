import type { NormalizedResponse } from '../../core/http/types';
import type { WebhookRequest } from '../../core/trigger';
import { FakeTransport, stubAuth } from '../../testing/fakes';
import { MemoryStore } from '../../testing/memory-store';
import { newPush, type GithubPushEvent } from './new-push.webhook';
import { signGithubBody } from './signature';

const SECRET = 'per-trigger-signing-secret';
const WEBHOOK_URL = 'https://runtime.example.com/api/hooks/abc-123';
const PROPS = { owner: 'octocat', repo: 'hello-world' };

/** A signed inbound delivery, exactly as the runtime would hand it to the SDK. */
function delivery(event: string, payload: unknown, secret = SECRET): WebhookRequest {
  const rawBody = JSON.stringify(payload);
  return {
    headers: {
      'x-github-event': event,
      'x-github-delivery': 'd-0001',
      'x-hub-signature-256': signGithubBody(rawBody, secret),
    },
    body: payload,
    rawBody,
  };
}

const PUSH_PAYLOAD = {
  ref: 'refs/heads/main',
  before: '1111111111111111111111111111111111111111',
  after: '2222222222222222222222222222222222222222',
  repository: { full_name: 'octocat/hello-world' },
  pusher: { name: 'octocat' },
  commits: [
    {
      id: 'c1',
      message: 'first',
      url: 'https://github.com/octocat/hello-world/commit/c1',
      author: { name: 'octocat' },
    },
  ],
};

describe('github.new_push — registration contract (onEnable/onDisable)', () => {
  it('onEnable creates a repo webhook pointed at the URL, signed with the secret, and returns the hook id', async () => {
    const transport = new FakeTransport((): NormalizedResponse => ({
      status: 201,
      headers: {},
      data: { id: 4242 },
    }));
    const registration = await newPush.enable({
      auth: stubAuth(transport),
      props: PROPS,
      store: new MemoryStore(),
      webhookUrl: WEBHOOK_URL,
      secret: SECRET,
    });

    // The handle the runtime persists is the GitHub hook id.
    expect(registration).toEqual({ subscriptionId: '4242' });

    // It registered exactly one POST to the repo hooks endpoint…
    expect(transport.requests).toHaveLength(1);
    const sent = transport.requests[0];
    expect(sent?.method).toBe('POST');
    expect(sent?.url).toBe('https://api.github.com/repos/octocat/hello-world/hooks');
    // …carrying the intake url and signing secret, subscribed to push.
    const body = sent?.body as {
      events: string[];
      config: { url: string; secret: string; content_type: string };
    };
    expect(body.events).toEqual(['push']);
    expect(body.config.url).toBe(WEBHOOK_URL);
    expect(body.config.secret).toBe(SECRET);
    expect(body.config.content_type).toBe('json');
  });

  it('onDisable deletes exactly the hook that onEnable created', async () => {
    const transport = new FakeTransport((): NormalizedResponse => ({
      status: 204,
      headers: {},
      data: undefined,
    }));
    await newPush.disable({
      auth: stubAuth(transport),
      props: PROPS,
      store: new MemoryStore(),
      webhookUrl: WEBHOOK_URL,
      secret: SECRET,
      registration: { subscriptionId: '4242' },
    });
    expect(transport.requests).toHaveLength(1);
    const sent = transport.requests[0];
    expect(sent?.method).toBe('DELETE');
    expect(sent?.url).toBe('https://api.github.com/repos/octocat/hello-world/hooks/4242');
  });

  it('onDisable tolerates a 404 (hook already gone) — teardown is idempotent', async () => {
    const transport = new FakeTransport((): NormalizedResponse => ({
      status: 404,
      headers: {},
      data: { message: 'Not Found' },
    }));
    await expect(
      newPush.disable({
        auth: stubAuth(transport),
        props: PROPS,
        store: new MemoryStore(),
        webhookUrl: WEBHOOK_URL,
        secret: SECRET,
        registration: { subscriptionId: '4242' },
      }),
    ).resolves.toBeUndefined();
  });

  it('onDisable with no registration is a no-op (never calls the provider)', async () => {
    const transport = new FakeTransport((): NormalizedResponse => ({
      status: 204,
      headers: {},
      data: undefined,
    }));
    await newPush.disable({
      auth: stubAuth(transport),
      props: PROPS,
      store: new MemoryStore(),
      webhookUrl: WEBHOOK_URL,
      secret: SECRET,
    });
    expect(transport.requests).toHaveLength(0);
  });
});

describe('github.new_push — inbound verification + transform', () => {
  // No transport is needed on the intake path; a throwing one proves it never calls out.
  const noNetwork = stubAuth(
    new FakeTransport(() => {
      throw new Error('intake must not call the network');
    }),
  );

  it('rejects a delivery whose signature does not match (spoofed)', async () => {
    const req = delivery('push', PUSH_PAYLOAD, 'the-attackers-secret');
    await expect(
      newPush.handleRequest({
        auth: noNetwork,
        props: PROPS,
        store: new MemoryStore(),
        request: req,
        secrets: { signingSecret: SECRET },
      }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('transforms a signed push into a normalised event', async () => {
    const events = await newPush.handleRequest({
      auth: noNetwork,
      props: PROPS,
      store: new MemoryStore(),
      request: delivery('push', PUSH_PAYLOAD),
      secrets: { signingSecret: SECRET },
    });
    expect(events).toEqual<GithubPushEvent[]>([
      {
        repo: 'octocat/hello-world',
        ref: 'refs/heads/main',
        before: '1111111111111111111111111111111111111111',
        after: '2222222222222222222222222222222222222222',
        pusher: 'octocat',
        commits: [
          {
            id: 'c1',
            message: 'first',
            url: 'https://github.com/octocat/hello-world/commit/c1',
            author: 'octocat',
          },
        ],
        deliveryId: 'd-0001',
      },
    ]);
  });

  it('acknowledges the signed ping GitHub sends on creation without firing an event', async () => {
    const events = await newPush.handleRequest({
      auth: noNetwork,
      props: PROPS,
      store: new MemoryStore(),
      request: delivery('ping', { zen: 'Keep it logically awesome.', hook_id: 4242 }),
      secrets: { signingSecret: SECRET },
    });
    expect(events).toEqual([]);
  });

  it('dedupes a redelivered push (same X-GitHub-Delivery fires once)', async () => {
    const store = new MemoryStore();
    const first = await newPush.handleRequest({
      auth: noNetwork,
      props: PROPS,
      store,
      request: delivery('push', PUSH_PAYLOAD),
      secrets: { signingSecret: SECRET },
    });
    const second = await newPush.handleRequest({
      auth: noNetwork,
      props: PROPS,
      store,
      request: delivery('push', PUSH_PAYLOAD),
      secrets: { signingSecret: SECRET },
    });
    expect(first).toHaveLength(1);
    expect(second).toEqual([]);
  });
});
