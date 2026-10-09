import { createDirectAuth } from '../../core/auth-factories';
import { HttpClient } from '../../core/http/client';
import { LIVE, liveDescribe } from '../../testing/live';
import { githubTokenAuth, listIssues } from './list-issues';

/** LIVE smoke test: github.list_issues against the real REST API, unauthenticated. Gated by ORCHESTR_LIVE. */
liveDescribe('github — live via direct transport (unauthenticated)', () => {
  // Same action, same seam — a `none` credential just skips the Authorization header.
  const auth = createDirectAuth(githubTokenAuth, { type: 'none' });
  const http = new HttpClient();

  it('list_issues paginates a public repo via the Link header', async () => {
    const out = await listIssues.execute({
      auth,
      http,
      props: { owner: 'microsoft', repo: 'vscode', state: 'open', limit: 120 },
    });

    // >100 collected ⇒ more than one page was fetched (per_page maxes at 100).
    expect(out.count).toBeGreaterThan(100);
    expect(out.count).toBeLessThanOrEqual(120);
    for (const issue of out.issues) {
      expect(typeof issue.number).toBe('number');
      expect(typeof issue.title).toBe('string');
      expect(issue.pull_request).toBeUndefined(); // PRs are filtered out
    }

    console.log(`live: github.list_issues → ${out.count} real issues across multiple pages`);
  }, 30_000);
});

const token = process.env.GITHUB_LIVE_TOKEN;
(LIVE && token ? describe : describe.skip)(
  'github — live with a real token, scoped to api.github.com',
  () => {
    it('list_issues walks every Link-header page with a real token scoped to api.github.com', async () => {
      const auth = createDirectAuth(githubTokenAuth, { type: 'apiKey', value: token ?? '' });
      const out = await listIssues.execute({
        auth,
        http: new HttpClient(),
        props: { owner: 'microsoft', repo: 'vscode', state: 'open', limit: 120 },
      });
      expect(out.count).toBeGreaterThan(100);
    }, 30_000);
  },
);
