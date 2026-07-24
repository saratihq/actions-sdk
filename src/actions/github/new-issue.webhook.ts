import { defineTrigger, type WebhookRegistration } from '../../core/trigger';
import { shortText } from '../../core/props';
import { githubTokenAuth } from './list-issues';
import { createRepoWebhook, deleteRepoWebhook, verifyGithubDelivery } from './webhook-common';

/** Public type for the registered-webhook trigger. */
export const NEW_ISSUE_TYPE = 'github.new_issue';

/**
 * A normalised issue event — what a workflow step receives. Trimmed to the fields
 * workflows use; `action` is carried so a workflow can branch on `opened` vs
 * `edited`/`closed`/… downstream (GitHub delivers every issue action on the
 * `issues` subscription).
 */
export interface GithubIssueEvent {
  /** `opened` | `edited` | `closed` | `reopened` | `labeled` | … */
  action: string;
  /** `owner/repo`. */
  repo: string;
  number: number;
  title: string;
  /** `open` | `closed`. */
  state: string;
  /** The issue's html URL. */
  url: string;
  body?: string;
  author?: string;
  labels: string[];
  /** The account that triggered the event. */
  sender?: string;
  /** GitHub's per-delivery id (`X-GitHub-Delivery`) — the retry-dedup key. */
  deliveryId?: string;
}

/** The GitHub `issues` payload envelope (the shapes we care about). */
interface GithubIssuePayload {
  action?: string;
  issue?: {
    number?: number;
    title?: string;
    state?: string;
    body?: string;
    html_url?: string;
    user?: { login?: string };
    labels?: Array<{ name?: string }>;
  };
  repository?: { full_name?: string };
  sender?: { login?: string };
}

/**
 * A REGISTERED webhook trigger for GitHub issues: `onEnable` creates a repo
 * webhook subscribed to the `issues` event, pointed at the configured public intake and
 * signed with the runtime's per-trigger secret; inbound deliveries are
 * authenticated by their `X-Hub-Signature-256` HMAC before the payload is
 * trusted; `onDisable` deletes the hook. Mirrors `github.new_push` exactly (same
 * register/verify/dedupe contract) — only the subscribed event and the transform
 * differ. GitHub sends every issue action on this subscription; the transform
 * carries `action` so the workflow filters downstream.
 */
export const newIssue = defineTrigger({
  type: NEW_ISSUE_TYPE,
  strategy: 'webhook',
  name: 'New issue',
  description: 'Fires when an issue is opened or updated in a GitHub repository.',
  auth: githubTokenAuth,
  props: {
    owner: shortText({ label: 'Owner', description: 'Repository owner or org.', required: true }),
    repo: shortText({ label: 'Repository', description: 'Repository name.', required: true }),
  },
  sampleData: {
    action: 'opened',
    repo: 'octocat/hello-world',
    number: 42,
    title: 'Found a bug',
    state: 'open',
    url: 'https://github.com/octocat/hello-world/issues/42',
    body: 'Steps to reproduce…',
    author: 'octocat',
    labels: ['bug'],
    sender: 'octocat',
  },
  /** Register a repo webhook subscribed to `issues`, pointed at our intake, signed with `secret`. */
  async onEnable({ http, auth, props, webhookUrl, secret }): Promise<WebhookRegistration> {
    return createRepoWebhook(http, auth, {
      owner: props.owner,
      repo: props.repo,
      events: ['issues'],
      webhookUrl,
      secret,
    });
  },
  /** Delete the repo webhook. A 404 means it's already gone — teardown is idempotent. */
  async onDisable({ http, auth, props, registration }): Promise<void> {
    await deleteRepoWebhook(http, auth, { owner: props.owner, repo: props.repo, registration });
  },
  /** Authenticate the delivery with the per-trigger secret before trusting the payload. */
  verify: verifyGithubDelivery,
  onRequest({ request }): GithubIssueEvent[] {
    // GitHub's event type lives in a header, never the body. The `ping` GitHub
    // sends on hook creation is an authentic, signed delivery that carries no
    // issue — acknowledge anything that isn't an issues event (return nothing).
    if (request.headers['x-github-event'] !== 'issues') return [];

    const body = request.body as GithubIssuePayload | undefined;
    const issue = body?.issue;
    if (!body || !issue || typeof issue.number !== 'number') return [];
    const deliveryId = request.headers['x-github-delivery'];
    return [
      {
        action: body.action ?? '',
        repo: body.repository?.full_name ?? '',
        number: issue.number,
        title: issue.title ?? '',
        state: issue.state ?? '',
        url: issue.html_url ?? '',
        ...(issue.body ? { body: issue.body } : {}),
        ...(issue.user?.login ? { author: issue.user.login } : {}),
        labels: (issue.labels ?? []).map((l) => l.name ?? '').filter((name) => name !== ''),
        ...(body.sender?.login ? { sender: body.sender.login } : {}),
        ...(deliveryId ? { deliveryId } : {}),
      },
    ];
  },
  /** GitHub redelivers on failure with the same `X-GitHub-Delivery` — dedupe on it. */
  dedupeKey: (event) => event.deliveryId ?? `${event.repo}:issue:${event.number}:${event.action}`,
});
