import { createDirectAuth } from '../../core/auth-factories';
import { HttpClient } from '../../core/http/client';
import { resolveFetch } from '../../core/http/types';
import { LIVE } from '../../testing/live';
import { MemoryStore } from '../../testing/memory-store';
import { githubTokenAuth } from './list-issues';
import { newPush } from './new-push.webhook';
import { signGithubBody, verifyGithubSignature } from './signature';

/**
 * LIVE proof of the REGISTERED-webhook half of the trigger contract. Against a
 * real GitHub repo it runs the full lifecycle end to end:
 *
 *   onEnable → GitHub creates a real repo webhook (real REST POST)
 *            → GET confirms it exists, pointed at the configured URL, subscribed to push
 *   signature cross-check → GitHub signs the `ping` it delivers with the trigger's secret;
 *            the test fetches that delivery and proves `verifyGithubSignature` accepts
 *            GitHub's own X-Hub-Signature-256, and rejects a tampered copy
 *   onDisable → GitHub deletes the webhook (real REST DELETE) → GET is 404
 *
 * Gated behind ORCHESTR_LIVE plus GITHUB_LIVE_TOKEN (a PAT/OAuth token with
 * `repo`) and GITHUB_TEST_REPO (`owner/repo`). Self-skips with a printed reason
 * otherwise, so `pnpm test` stays green offline and never fakes the proof.
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
    // A REACHABLE sink (returns 200) so GitHub actually delivers — and signs — the
    // creation `ping`, giving the deliveries API a real signed record to verify
    // against. GITHUB_TEST_SINK_URL overrides it (e.g. a webhook.site url).
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
      // GitHub delivers a signed `ping` a few seconds after creation; until the
      // first delivery is recorded the deliveries endpoint itself 404s, so poll
      // tolerantly. Delivery ids are 64-bit and exceed JS's safe integer, so read
      // the ping's id as a STRING off the raw JSON (JSON.parse would round it and
      // the detail fetch would 404 on the wrong id).
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

      // The real proof: GitHub computed X-Hub-Signature-256 as HMAC-SHA256 of the
      // exact bytes it POSTed, keyed by the trigger's secret. Node's `JSON.stringify` emits
      // the same compact bytes GitHub signed, so verify() — handed GitHub's own
      // header over the re-serialised body — must accept it. A flipped byte rejects.
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
