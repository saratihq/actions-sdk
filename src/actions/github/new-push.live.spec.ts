import { createDirectAuth } from '../../core/auth-factories';
import { HttpClient } from '../../core/http/client';
import { resolveFetch } from '../../core/http/types';
import { LIVE } from '../../testing/live';
import { MemoryStore } from '../../testing/memory-store';
import { githubTokenAuth } from './list-issues';
import { newPush } from './new-push.webhook';
import { signGithubBody, verifyGithubSignature } from './signature';

/**
 * LIVE registration lifecycle (onEnable → signature cross-check → onDisable) against a real repo.
 * Gated by ORCHESTR_LIVE plus GITHUB_LIVE_TOKEN (needs `repo`) and GITHUB_TEST_REPO (`owner/repo`).
 */
const token = process.env.GITHUB_LIVE_TOKEN;
const repoSlug = process.env.GITHUB_TEST_REPO;
const enabled = LIVE && Boolean(token) && Boolean(repoSlug);
const describeLive = enabled ? describe : describe.skip;
const reason = !LIVE
  ? 'set ORCHESTR_LIVE=1'
  : !token
    ? 'GITHUB_LIVE_TOKEN is unset'
    : 'GITHUB_TEST_REPO is unset (owner/repo)';

interface GithubHookView {
  id: number;
  active: boolean;
  events: string[];
  config: { url?: string; content_type?: string };
}
interface DeliveryDetail {
  request: { headers: Record<string, string>; payload: unknown };
}

const GITHUB_API_BASE = 'https://api.github.com';
const HEADERS: Record<string, string> = {
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
  'user-agent': 'orchestr-actions-sdk',
};

describeLive(
  `github.new_push — LIVE registration lifecycle [${enabled ? 'running' : `skipped: ${reason}`}]`,
  () => {
    const [owner, repo] = (repoSlug ?? '/').split('/');
    const auth = createDirectAuth(githubTokenAuth, { type: 'bearer', token: token ?? '' });
    const http = new HttpClient();
    // Must be a REACHABLE sink, or GitHub never delivers (and signs) the `ping` this test verifies.
    const webhookUrl = process.env.GITHUB_TEST_SINK_URL || 'https://httpbin.org/post';
    const secret = `live-secret-${Math.random().toString(36).slice(2)}`;

    let subscriptionId = '';

    afterAll(async () => {
      // Belt-and-braces: never leak a hook if an assertion aborted mid-test.
      if (subscriptionId) {
        await http
          .delete(`${GITHUB_API_BASE}/repos/${owner}/${repo}/hooks/${subscriptionId}`, {
            auth,
            headers: HEADERS,
            throwOnError: false,
          })
          .catch(() => undefined);
      }
    });

    it('onEnable creates a real repo webhook and returns its id', async () => {
      const registration = await newPush.enable({
        auth,
        props: { owner, repo },
        store: new MemoryStore(),
        webhookUrl,
        secret,
      });
      expect(registration?.subscriptionId).toBeTruthy();
      subscriptionId = registration?.subscriptionId ?? '';

      const view = await http.get<GithubHookView>(
        `${GITHUB_API_BASE}/repos/${owner}/${repo}/hooks/${subscriptionId}`,
        { auth, headers: HEADERS },
      );
      expect(view.data.active).toBe(true);
      expect(view.data.events).toContain('push');
      expect(view.data.config.url).toBe(webhookUrl);
      console.log(`live: github.new_push → created real repo hook #${subscriptionId} on ${owner}/${repo}`);
    }, 30_000);

    it("verify() accepts GitHub's own signature on the ping it delivered, and rejects a tamper", async () => {
      // Delivery ids are 64-bit and exceed JS's safe integer, so the id must be read as a STRING
      // off the raw JSON — JSON.parse would round it and the detail fetch would 404.
      const doFetch = resolveFetch();
      const listUrl = `${GITHUB_API_BASE}/repos/${owner}/${repo}/hooks/${subscriptionId}/deliveries?per_page=30`;
      let ping: DeliveryDetail | null = null;
      for (let attempt = 0; attempt < 15 && !ping; attempt++) {
        const res = await doFetch(listUrl, {
          headers: { ...HEADERS, authorization: `Bearer ${token ?? ''}` },
        });
        if (res.status === 200) {
          const text = await res.text();
          const pingId = [...text.matchAll(/"id":(\d+)[^{}]*?"event":"(\w+)"/g)].find(
            (m) => m[2] === 'ping',
          )?.[1];
          if (pingId) {
            const detail = await http.get<DeliveryDetail>(
              `${GITHUB_API_BASE}/repos/${owner}/${repo}/hooks/${subscriptionId}/deliveries/${pingId}`,
              { auth, headers: HEADERS },
            );
            ping = detail.data;
          }
        }
        if (!ping) await new Promise((r) => setTimeout(r, 1500));
      }
      expect(ping).not.toBeNull();
      const headers = lowerCaseKeys(ping?.request.headers ?? {});
      const githubSig = headers['x-hub-signature-256'];
      expect(githubSig).toMatch(/^sha256=/);
      if (!githubSig) throw new Error('ping delivery carried no X-Hub-Signature-256');

      // `JSON.stringify` reproduces the exact compact bytes GitHub signed, so verify() must accept them.
      const rawBody = JSON.stringify(ping?.request.payload ?? {});
      const authentic = {
        headers: { 'x-hub-signature-256': githubSig },
        body: ping?.request.payload,
        rawBody,
      };
      expect(verifyGithubSignature(authentic, secret)).toBe(true);
      expect(verifyGithubSignature({ ...authentic, rawBody: `${rawBody} ` }, secret)).toBe(false);
      expect(signGithubBody(rawBody, secret)).toBe(githubSig); // our HMAC == GitHub's, byte-for-byte
      console.log(
        `live: verify() accepted GitHub's own X-Hub-Signature-256 (${githubSig.slice(0, 22)}…) over the real ping`,
      );
    }, 45_000);

    it('onDisable deletes the webhook — it is gone', async () => {
      await newPush.disable({
        auth,
        props: { owner, repo },
        store: new MemoryStore(),
        webhookUrl,
        secret,
        registration: { subscriptionId },
      });
      const gone = await http.get(`${GITHUB_API_BASE}/repos/${owner}/${repo}/hooks/${subscriptionId}`, {
        auth,
        headers: HEADERS,
        throwOnError: false,
      });
      expect(gone.status).toBe(404);
      console.log(`live: github.new_push → deleted real repo hook #${subscriptionId} (now 404)`);
      subscriptionId = ''; // deleted; skip the afterAll cleanup
    }, 30_000);
  },
);

function lowerCaseKeys(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) out[k.toLowerCase()] = v;
  return out;
}
