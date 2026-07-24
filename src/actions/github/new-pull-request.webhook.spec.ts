import type { NormalizedResponse } from '../../core/http/types';
import type { WebhookRequest } from '../../core/trigger';
import { FakeTransport, stubAuth } from '../../testing/fakes';
import { MemoryStore } from '../../testing/memory-store';
import { type GithubPullRequestEvent, newPullRequest } from './new-pull-request.webhook';
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
      'x-github-delivery': 'd-pr-1',
      'x-hub-signature-256': signGithubBody(rawBody, secret),
    },
    body: payload,
    rawBody,
  };
}

/** A GitHub `pull_request` webhook payload (shape from the public event docs). */
const PR_PAYLOAD = {
  action: 'opened',
  number: 7,
  pull_request: {
    number: 7,
    title: 'Amazing new feature',
    state: 'open',
    body: 'Please pull these awesome changes in!',
    html_url: 'https://github.com/octocat/hello-world/pull/7',
    draft: false,
    merged: false,
    user: { login: 'octocat' },
    head: { ref: 'feature-branch' },
    base: { ref: 'main' },
  },
  repository: { full_name: 'octocat/hello-world' },
  sender: { login: 'contributor-sam' },
};

describe('github.new_pull_request — registration contract (onEnable/onDisable)', () => {
  it('onEnable creates a repo webhook subscribed to `pull_request`, pointed at the URL, signed with the secret', async () => {
    const transport = new FakeTransport((): NormalizedResponse => ({
      status: 201,
      headers: {},
      data: { id: 7007 },
    }));
    const registration = await newPullRequest.enable({
      auth: stubAuth(transport),
      props: PROPS,
      store: new MemoryStore(),
      webhookUrl: WEBHOOK_URL,
      secret: SECRET,
    });

    expect(registration).toEqual({ subscriptionId: '7007' });
    expect(transport.requests).toHaveLength(1);
    const sent = transport.requests[0];
    expect(sent?.method).toBe('POST');
    expect(sent?.url).toBe('https://api.github.com/repos/octocat/hello-world/hooks');
    const body = sent?.body as {
      events: string[];
      config: { url: string; secret: string; content_type: string };
    };
    // The DISTINGUISHING assertion — this trigger subscribes to the `pull_request` event.
    expect(body.events).toEqual(['pull_request']);
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
    await newPullRequest.disable({
      auth: stubAuth(transport),
      props: PROPS,
      store: new MemoryStore(),
      webhookUrl: WEBHOOK_URL,
      secret: SECRET,
      registration: { subscriptionId: '7007' },
    });
    expect(transport.requests).toHaveLength(1);
    const sent = transport.requests[0];
    expect(sent?.method).toBe('DELETE');
    expect(sent?.url).toBe('https://api.github.com/repos/octocat/hello-world/hooks/7007');
  });
});

describe('github.new_pull_request — inbound verification + transform', () => {
  // No transport is needed on the intake path; a throwing one proves it never calls out.
  const noNetwork = stubAuth(
    new FakeTransport(() => {
      throw new Error('intake must not call the network');
    }),
  );

  it('rejects a delivery whose signature does not match (spoofed)', async () => {
    await expect(
      newPullRequest.handleRequest({
        auth: noNetwork,
        props: PROPS,
        store: new MemoryStore(),
        request: delivery('pull_request', PR_PAYLOAD, 'the-attackers-secret'),
        secrets: { signingSecret: SECRET },
      }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('transforms a signed pull_request delivery into a normalised event', async () => {
    const events = await newPullRequest.handleRequest({
      auth: noNetwork,
      props: PROPS,
      store: new MemoryStore(),
      request: delivery('pull_request', PR_PAYLOAD),
      secrets: { signingSecret: SECRET },
    });
    expect(events).toEqual<GithubPullRequestEvent[]>([
      {
        action: 'opened',
        repo: 'octocat/hello-world',
        number: 7,
        title: 'Amazing new feature',
        state: 'open',
        url: 'https://github.com/octocat/hello-world/pull/7',
        body: 'Please pull these awesome changes in!',
        author: 'octocat',
        draft: false,
        merged: false,
        head: 'feature-branch',
        base: 'main',
        sender: 'contributor-sam',
        deliveryId: 'd-pr-1',
      },
    ]);
  });

  it('acknowledges the signed ping GitHub sends on creation without firing an event', async () => {
    const events = await newPullRequest.handleRequest({
      auth: noNetwork,
      props: PROPS,
      store: new MemoryStore(),
      request: delivery('ping', { zen: 'Keep it logically awesome.', hook_id: 7007 }),
      secrets: { signingSecret: SECRET },
    });
    expect(events).toEqual([]);
  });

  it('dedupes a redelivered pull_request event (same X-GitHub-Delivery fires once)', async () => {
    const store = new MemoryStore();
    const first = await newPullRequest.handleRequest({
      auth: noNetwork,
      props: PROPS,
      store,
      request: delivery('pull_request', PR_PAYLOAD),
      secrets: { signingSecret: SECRET },
    });
    const second = await newPullRequest.handleRequest({
      auth: noNetwork,
      props: PROPS,
      store,
      request: delivery('pull_request', PR_PAYLOAD),
      secrets: { signingSecret: SECRET },
    });
    expect(first).toHaveLength(1);
    expect(second).toEqual([]);
  });
});
