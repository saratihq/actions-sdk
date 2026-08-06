# Writing a trigger

A trigger starts a workflow when something happens at a provider. Set `strategy` to `'polling'` or
`'webhook'`.

## Polling triggers

Poll the provider on a schedule and return candidate items. The SDK drops ones already emitted
(by `dedupeKey`) and tracks the last-polled watermark for you.

```ts
import { defineTrigger, shortText, none } from '@sarati/actions-sdk';

export const newStory = defineTrigger({
  type: 'hackernews.new_story',
  name: 'New story',
  auth: none,
  props: { topic: shortText({ label: 'Topic' }) },
  strategy: 'polling',
  // ctx: { auth, props, http, store, lastPolledAt? } — use lastPolledAt to bound the query.
  async poll({ props, http }) {
    return fetchStories(http, props.topic); // newest-relevant first
  },
  // Stable id per item, so one seen in a prior poll isn't re-emitted.
  dedupeKey: (story) => String(story.id),
});
```

A consumer runs one cycle with `runPoll({ auth, props, store })` and gets back only the new events
plus the advanced watermark.

## Webhook triggers

Receive a provider callback, verify it, and turn it into events. A registered webhook also creates
and removes the provider-side subscription per connection.

```ts
import { defineTrigger, shortText, type WebhookRegistration } from '@sarati/actions-sdk';

export const newIssue = defineTrigger({
  type: 'github.new_issue',
  name: 'New issue',
  auth: githubToken,
  props: { repo: shortText({ label: 'Repository', required: true }) },
  strategy: 'webhook',
  // Register the subscription; return a handle the runtime persists.
  async onEnable({ http, auth, props, webhookUrl, secret }): Promise<WebhookRegistration> {
    const hook = await createRepoWebhook(http, auth, props.repo, webhookUrl, secret);
    return { subscriptionId: String(hook.id) };
  },
  // Remove it on disable; `registration` is the handle onEnable returned.
  async onDisable({ http, auth, props, registration }) {
    if (registration) await deleteRepoWebhook(http, auth, props.repo, registration.subscriptionId);
  },
  // Reject requests whose signature doesn't match. Return false to drop.
  verify: (request, secrets) => verifyHmac(request, secrets),
  // Transform an authentic request into zero or more events.
  onRequest: ({ request }) => extractIssueEvents(request.body),
  // Optional: dedup provider retries.
  dedupeKey: (event) => event.deliveryId,
});
```

Each `request` is `{ headers, body, rawBody? }` — use `rawBody` for signature checks. Always
`verify` before trusting the payload; test verification with known HMAC vectors in a `*.spec.ts`.

For **app-level** webhooks (one subscription for the whole app, e.g. Slack Events), omit
`onEnable`/`onDisable` and implement `handshake` (echo the provider's verification challenge),
`verify`, and `onRequest`.
