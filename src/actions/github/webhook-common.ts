import type { AuthHandle } from '../../core/auth';
import type { HttpClient } from '../../core/http/client';
import type { WebhookRegistration, WebhookRequest } from '../../core/trigger';
import { verifyGithubSignature } from './signature';

/**
 * Shared plumbing for GitHub's REGISTERED-webhook triggers (`new_issue`,
 * `new_pull_request`, …). Every one registers the SAME repo-hook shape — only the
 * `events` array and the payload transform differ — so the create/delete API
 * calls and the signature check live here, authored once. (The reference
 * `new-push.webhook.ts` predates this helper and keeps its own inline copy; it is
 * a frozen reference and deliberately left untouched.)
 */

export const GITHUB_API_BASE = 'https://api.github.com';
export const GITHUB_HEADERS: Record<string, string> = {
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
  // GitHub rejects requests without a User-Agent.
  'user-agent': 'orchestr-actions-sdk',
};

/** The create-hook response (only `id`, the subscription handle, matters). */
interface GithubHook {
  id: number;
}

/**
 * Register a repo webhook for `events`, pointed at the configured public intake URL and
 * signed with the runtime's per-trigger secret. Returns the GitHub hook id as
 * the {@link WebhookRegistration} handle so `onDisable` can delete exactly it.
 */
export async function createRepoWebhook(
  http: HttpClient,
  auth: AuthHandle,
  opts: { owner: string; repo: string; events: string[]; webhookUrl: string; secret: string },
): Promise<WebhookRegistration> {
  const owner = encodeURIComponent(opts.owner);
  const repo = encodeURIComponent(opts.repo);
  const res = await http.post<GithubHook>(`${GITHUB_API_BASE}/repos/${owner}/${repo}/hooks`, {
    auth,
    headers: GITHUB_HEADERS,
    body: {
      name: 'web',
      active: true,
      events: opts.events,
      config: { url: opts.webhookUrl, content_type: 'json', secret: opts.secret, insecure_ssl: '0' },
    },
  });
  return { subscriptionId: String(res.data.id) };
}

/** Delete the repo webhook `registration` named. A 404 means it's already gone — teardown is idempotent. */
export async function deleteRepoWebhook(
  http: HttpClient,
  auth: AuthHandle,
  opts: { owner: string; repo: string; registration?: WebhookRegistration },
): Promise<void> {
  if (!opts.registration?.subscriptionId) return;
  const owner = encodeURIComponent(opts.owner);
  const repo = encodeURIComponent(opts.repo);
  const id = encodeURIComponent(opts.registration.subscriptionId);
  const res = await http.delete(`${GITHUB_API_BASE}/repos/${owner}/${repo}/hooks/${id}`, {
    auth,
    headers: GITHUB_HEADERS,
    throwOnError: false,
  });
  if (res.status !== 404 && (res.status < 200 || res.status >= 300)) {
    throw new Error(`GitHub hook delete failed: HTTP ${res.status}`);
  }
}

/**
 * Authenticate an inbound delivery with the per-trigger secret before trusting
 * the payload — the `X-Hub-Signature-256` HMAC every registered github webhook
 * relies on. Returns false (never throws) for any missing/malformed input.
 */
export function verifyGithubDelivery(request: WebhookRequest, secrets: Record<string, string>): boolean {
  const secret = secrets.signingSecret;
  return secret ? verifyGithubSignature(request, secret) : false;
}
