import { defineTrigger, type WebhookRegistration } from '../../core/trigger';
import { shortText } from '../../core/props';
import { githubTokenAuth } from './list-issues';
import { verifyGithubSignature } from './signature';

/** Public type for the registered-webhook trigger. */
export const NEW_PUSH_TYPE = 'github.new_push';

const GITHUB_API_BASE = 'https://api.github.com';
const GITHUB_HEADERS: Record<string, string> = {
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
  // GitHub rejects requests without a User-Agent.
  'user-agent': 'orchestr-actions-sdk',
};

/** A normalised push event — what a workflow step receives. Fields trimmed to what workflows use. */
export interface GithubPushEvent {
  /** `owner/repo`. */
  repo: string;
  /** e.g. `refs/heads/main`. */
  ref: string;
  before: string;
  after: string;
  pusher?: string;
  commits: Array<{ id: string; message: string; url: string; author?: string }>;
  /** GitHub's per-delivery id (`X-GitHub-Delivery`) — the retry-dedup key. */
  deliveryId?: string;
}

/** The GitHub `push` payload envelope (the relevant fields). */
interface GithubPushPayload {
  ref?: string;
  before?: string;
  after?: string;
  repository?: { full_name?: string };
  pusher?: { name?: string };
  commits?: Array<{ id?: string; message?: string; url?: string; author?: { name?: string } }>;
}

/** The create-hook response (only `id`, the subscription handle, matters). */
interface GithubHook {
  id: number;
}

/**
 * A REGISTERED webhook trigger: `onEnable` creates a real repo webhook via the
 * GitHub API pointing at a public intake URL and signed with the runtime's
 * per-trigger secret, then returns the hook id as the {@link WebhookRegistration}
 * handle. Inbound deliveries are authenticated by their `X-Hub-Signature-256`
 * HMAC before the payload is trusted; `onDisable` deletes the hook by that id.
 *
 * This exercises the `onEnable`/`onDisable` half of the trigger contract — the
 * register-per-connection webhook shape.
 */
export const newPush = defineTrigger({
  type: NEW_PUSH_TYPE,
  strategy: 'webhook',
  name: 'New push',
  description: 'Fires when commits are pushed to a GitHub repository.',
  auth: githubTokenAuth,
  props: {
    owner: shortText({ label: 'Owner', description: 'Repository owner or org.', required: true }),
    repo: shortText({ label: 'Repository', description: 'Repository name.', required: true }),
  },
  sampleData: {
    repo: 'octocat/hello-world',
    ref: 'refs/heads/main',
    before: '0000000000000000000000000000000000000000',
    after: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
    pusher: 'octocat',
    commits: [
      {
        id: 'a1b2c3d',
        message: 'Fix the thing',
        url: 'https://github.com/octocat/hello-world/commit/a1b2c3d',
      },
    ],
  },
  /**
   * Register a repo webhook pointing at the intake URL, signed with `secret`.
   * Returns the GitHub hook id so `onDisable` can delete exactly this hook.
   */
  async onEnable({ http, auth, props, webhookUrl, secret }): Promise<WebhookRegistration> {
    const owner = encodeURIComponent(props.owner);
    const repo = encodeURIComponent(props.repo);
    const res = await http.post<GithubHook>(`${GITHUB_API_BASE}/repos/${owner}/${repo}/hooks`, {
      auth,
      headers: GITHUB_HEADERS,
      body: {
        name: 'web',
        active: true,
        events: ['push'],
        config: { url: webhookUrl, content_type: 'json', secret, insecure_ssl: '0' },
      },
    });
    return { subscriptionId: String(res.data.id) };
  },
  /** Delete the repo webhook. A 404 means it's already gone — teardown is idempotent. */
  async onDisable({ http, auth, props, registration }): Promise<void> {
    if (!registration?.subscriptionId) return;
    const owner = encodeURIComponent(props.owner);
    const repo = encodeURIComponent(props.repo);
    const id = encodeURIComponent(registration.subscriptionId);
    const res = await http.delete(`${GITHUB_API_BASE}/repos/${owner}/${repo}/hooks/${id}`, {
      auth,
      headers: GITHUB_HEADERS,
      throwOnError: false,
    });
    if (res.status !== 404 && (res.status < 200 || res.status >= 300)) {
      throw new Error(`GitHub hook delete failed: HTTP ${res.status}`);
    }
  },
  /** Authenticate the delivery with the per-trigger secret before trusting the payload. */
  verify(request, secrets): boolean {
    const secret = secrets.signingSecret;
    return secret ? verifyGithubSignature(request, secret) : false;
  },
  onRequest({ request }): GithubPushEvent[] {
    // GitHub's event type lives in a header, never the body.
    const eventType = request.headers['x-github-event'];
    // The `ping` GitHub sends on hook creation is an authentic, signed delivery
    // that carries no push — acknowledge it (return nothing to fire).
    if (eventType !== 'push') return [];

    const body = request.body as GithubPushPayload | undefined;
    if (!body || typeof body.after !== 'string') return [];
    const deliveryId = request.headers['x-github-delivery'];
    return [
      {
        repo: body.repository?.full_name ?? '',
        ref: body.ref ?? '',
        before: body.before ?? '',
        after: body.after,
        ...(body.pusher?.name ? { pusher: body.pusher.name } : {}),
        commits: (body.commits ?? []).map((c) => ({
          id: c.id ?? '',
          message: c.message ?? '',
          url: c.url ?? '',
          ...(c.author?.name ? { author: c.author.name } : {}),
        })),
        ...(deliveryId ? { deliveryId } : {}),
      },
    ];
  },
  /** GitHub redelivers on failure with the same `X-GitHub-Delivery` — dedupe on it. */
  dedupeKey: (event) => event.deliveryId ?? `${event.repo}:${event.after}`,
});
