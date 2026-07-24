import { defineTrigger, type WebhookRegistration } from '../../core/trigger';
import { shortText } from '../../core/props';
import { githubTokenAuth } from './list-issues';
import { createRepoWebhook, deleteRepoWebhook, verifyGithubDelivery } from './webhook-common';

/** Public type for the registered-webhook trigger. */
export const NEW_PULL_REQUEST_TYPE = 'github.new_pull_request';

/**
 * A normalised pull-request event — what a workflow step receives. Trimmed to the
 * fields workflows use; `action` is carried so a workflow can branch on `opened`
 * vs `synchronize`/`closed`/… downstream (GitHub delivers every PR action on the
 * `pull_request` subscription).
 */
export interface GithubPullRequestEvent {
  /** `opened` | `edited` | `closed` | `reopened` | `synchronize` | … */
  action: string;
  /** `owner/repo`. */
  repo: string;
  number: number;
  title: string;
  /** `open` | `closed`. */
  state: string;
  /** The pull request's html URL. */
  url: string;
  body?: string;
  author?: string;
  draft: boolean;
  merged: boolean;
  /** The source branch (`head.ref`). */
  head: string;
  /** The target branch (`base.ref`). */
  base: string;
  /** The account that triggered the event. */
  sender?: string;
  /** GitHub's per-delivery id (`X-GitHub-Delivery`) — the retry-dedup key. */
  deliveryId?: string;
}

/** The GitHub `pull_request` payload envelope (the shapes we care about). */
interface GithubPullRequestPayload {
  action?: string;
  number?: number;
  pull_request?: {
    number?: number;
    title?: string;
    state?: string;
    body?: string;
    html_url?: string;
    draft?: boolean;
    merged?: boolean;
    user?: { login?: string };
    head?: { ref?: string };
    base?: { ref?: string };
  };
  repository?: { full_name?: string };
  sender?: { login?: string };
}

/**
 * A REGISTERED webhook trigger for GitHub pull requests: `onEnable` creates a
 * repo webhook subscribed to the `pull_request` event, pointed at the configured public
 * intake and signed with the runtime's per-trigger secret; inbound deliveries are
 * authenticated by their `X-Hub-Signature-256` HMAC before the payload is
 * trusted; `onDisable` deletes the hook. Mirrors `github.new_push` exactly (same
 * register/verify/dedupe contract) — only the subscribed event and the transform
 * differ. GitHub sends every PR action on this subscription; the transform
 * carries `action` so the workflow filters downstream.
 */
export const newPullRequest = defineTrigger({
  type: NEW_PULL_REQUEST_TYPE,
  strategy: 'webhook',
  name: 'New pull request',
  description: 'Fires when a pull request is opened or updated in a GitHub repository.',
  auth: githubTokenAuth,
  props: {
    owner: shortText({ label: 'Owner', description: 'Repository owner or org.', required: true }),
    repo: shortText({ label: 'Repository', description: 'Repository name.', required: true }),
  },
  sampleData: {
    action: 'opened',
    repo: 'octocat/hello-world',
    number: 7,
    title: 'Add the feature',
    state: 'open',
    url: 'https://github.com/octocat/hello-world/pull/7',
    body: 'This PR adds…',
    author: 'octocat',
    draft: false,
    merged: false,
    head: 'feature-branch',
    base: 'main',
    sender: 'octocat',
  },
  /** Register a repo webhook subscribed to `pull_request`, pointed at our intake, signed with `secret`. */
  async onEnable({ http, auth, props, webhookUrl, secret }): Promise<WebhookRegistration> {
    return createRepoWebhook(http, auth, {
      owner: props.owner,
      repo: props.repo,
      events: ['pull_request'],
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
  onRequest({ request }): GithubPullRequestEvent[] {
    // GitHub's event type lives in a header, never the body. The `ping` GitHub
    // sends on hook creation is an authentic, signed delivery that carries no PR —
    // acknowledge anything that isn't a pull_request event (return nothing).
    if (request.headers['x-github-event'] !== 'pull_request') return [];

    const body = request.body as GithubPullRequestPayload | undefined;
    const pr = body?.pull_request;
    if (!body || !pr || typeof pr.number !== 'number') return [];
    const deliveryId = request.headers['x-github-delivery'];
    return [
      {
        action: body.action ?? '',
        repo: body.repository?.full_name ?? '',
        number: pr.number,
        title: pr.title ?? '',
        state: pr.state ?? '',
        url: pr.html_url ?? '',
        ...(pr.body ? { body: pr.body } : {}),
        ...(pr.user?.login ? { author: pr.user.login } : {}),
        draft: pr.draft ?? false,
        merged: pr.merged ?? false,
        head: pr.head?.ref ?? '',
        base: pr.base?.ref ?? '',
        ...(body.sender?.login ? { sender: body.sender.login } : {}),
        ...(deliveryId ? { deliveryId } : {}),
      },
    ];
  },
  /** GitHub redelivers on failure with the same `X-GitHub-Delivery` — dedupe on it. */
  dedupeKey: (event) => event.deliveryId ?? `${event.repo}:pr:${event.number}:${event.action}`,
});
