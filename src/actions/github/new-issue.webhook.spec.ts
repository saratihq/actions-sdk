import type { NormalizedResponse } from '../../core/http/types';
import type { WebhookRequest } from '../../core/trigger';
import { FakeTransport, stubAuth } from '../../testing/fakes';
import { MemoryStore } from '../../testing/memory-store';
import { type GithubIssueEvent, newIssue } from './new-issue.webhook';
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
      'x-github-delivery': 'd-issue-1',
      'x-hub-signature-256': signGithubBody(rawBody, secret),
    },
    body: payload,
    rawBody,
  };
}

/** A GitHub `issues` webhook payload (shape from the public event docs). */
const ISSUE_PAYLOAD = {
  action: 'opened',
  issue: {
    number: 1347,
    title: 'Found a bug',
    state: 'open',
    body: 'It broke.',
    html_url: 'https://github.com/octocat/hello-world/issues/1347',
    user: { login: 'octocat' },
    labels: [{ name: 'bug' }, { name: 'triage' }],
  },
  repository: { full_name: 'octocat/hello-world' },
  sender: { login: 'reporter-jane' },
};

describe('github.new_issue — registration contract (onEnable/onDisable)', () => {
  it('onEnable creates a repo webhook subscribed to `issues`, pointed at the URL, signed with the secret', async () => {
    const transport = new FakeTransport((): NormalizedResponse => ({
      status: 201,
      headers: {},
      data: { id: 9001 },
    }));
    const registration = await newIssue.enable({
      auth: stubAuth(transport),
      props: PROPS,
      store: new MemoryStore(),
      webhookUrl: WEBHOOK_URL,
      secret: SECRET,
    });

    expect(registration).toEqual({ subscriptionId: '9001' });
    expect(transport.requests).toHaveLength(1);
    const sent = transport.requests[0];
    expect(sent?.method).toBe('POST');
    expect(sent?.url).toBe('https://api.github.com/repos/octocat/hello-world/hooks');
    const body = sent?.body as {
      events: string[];
      config: { url: string; secret: string; content_type: string };
    };
    // The DISTINGUISHING assertion — this trigger subscribes to the `issues` event.
    expect(body.events).toEqual(['issues']);
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
    await newIssue.disable({
      auth: stubAuth(transport),
      props: PROPS,
      store: new MemoryStore(),
      webhookUrl: WEBHOOK_URL,
      secret: SECRET,
      registration: { subscriptionId: '9001' },
    });
    expect(transport.requests).toHaveLength(1);
    const sent = transport.requests[0];
    expect(sent?.method).toBe('DELETE');
    expect(sent?.url).toBe('https://api.github.com/repos/octocat/hello-world/hooks/9001');
  });

  it('onDisable tolerates a 404 (hook already gone) — teardown is idempotent', async () => {
    const transport = new FakeTransport((): NormalizedResponse => ({
      status: 404,
      headers: {},
      data: { message: 'Not Found' },
    }));
    await expect(
      newIssue.disable({
        auth: stubAuth(transport),
        props: PROPS,
        store: new MemoryStore(),
        webhookUrl: WEBHOOK_URL,
        secret: SECRET,
        registration: { subscriptionId: '9001' },
      }),
    ).resolves.toBeUndefined();
  });
});

describe('github.new_issue — inbound verification + transform', () => {
  // No transport is needed on the intake path; a throwing one proves it never calls out.
  const noNetwork = stubAuth(
    new FakeTransport(() => {
      throw new Error('intake must not call the network');
    }),
  );

  it('rejects a delivery whose signature does not match (spoofed)', async () => {
    await expect(
      newIssue.handleRequest({
        auth: noNetwork,
        props: PROPS,
        store: new MemoryStore(),
        request: delivery('issues', ISSUE_PAYLOAD, 'the-attackers-secret'),
        secrets: { signingSecret: SECRET },
      }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('transforms a signed issues delivery into a normalised event', async () => {
    const events = await newIssue.handleRequest({
      auth: noNetwork,
      props: PROPS,
      store: new MemoryStore(),
      request: delivery('issues', ISSUE_PAYLOAD),
      secrets: { signingSecret: SECRET },
    });
    expect(events).toEqual<GithubIssueEvent[]>([
      {
        action: 'opened',
        repo: 'octocat/hello-world',
        number: 1347,
        title: 'Found a bug',
        state: 'open',
        url: 'https://github.com/octocat/hello-world/issues/1347',
        body: 'It broke.',
        author: 'octocat',
        labels: ['bug', 'triage'],
        sender: 'reporter-jane',
        deliveryId: 'd-issue-1',
      },
    ]);
  });

  it('acknowledges the signed ping GitHub sends on creation without firing an event', async () => {
    const events = await newIssue.handleRequest({
      auth: noNetwork,
      props: PROPS,
      store: new MemoryStore(),
      request: delivery('ping', { zen: 'Keep it logically awesome.', hook_id: 9001 }),
      secrets: { signingSecret: SECRET },
    });
    expect(events).toEqual([]);
  });

  it('dedupes a redelivered issue event (same X-GitHub-Delivery fires once)', async () => {
    const store = new MemoryStore();
    const first = await newIssue.handleRequest({
      auth: noNetwork,
      props: PROPS,
      store,
      request: delivery('issues', ISSUE_PAYLOAD),
      secrets: { signingSecret: SECRET },
    });
    const second = await newIssue.handleRequest({
      auth: noNetwork,
      props: PROPS,
      store,
      request: delivery('issues', ISSUE_PAYLOAD),
      secrets: { signingSecret: SECRET },
    });
    expect(first).toHaveLength(1);
    expect(second).toEqual([]);
  });
});
