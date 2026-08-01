import type { AuthHandle } from '../../core/auth';
import type { HttpClient } from '../../core/http/client';
import type { WebhookRegistration, WebhookRequest } from '../../core/trigger';
import { verifyGithubSignature } from './signature';

/** Shared plumbing for GitHub's registered-webhook triggers: one repo-hook shape, only `events` differs. */

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

/** Register a repo webhook for `events`, returning the GitHub hook id so `onDisable` deletes exactly it. */
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

/** Authenticate a delivery's `X-Hub-Signature-256` before trusting it; returns false, never throws. */
export function verifyGithubDelivery(request: WebhookRequest, secrets: Record<string, string>): boolean {
  const secret = secrets.signingSecret;
  return secret ? verifyGithubSignature(request, secret) : false;
}
