import { createDirectAuth } from '../../core/auth-factories';
import { HttpClient } from '../../core/http/client';
import { liveDescribe } from '../../testing/live';
import { githubTokenAuth, listIssues } from './list-issues';

/**
 * LIVE smoke test for the DIRECT transport: github.list_issues runs against the real
 * GitHub REST API, unauthenticated, over a public repository — proving the
 * direct transport, the apiKey auth scheme (here with a `none` credential), and
 * Link-header pagination. Gated behind ORCHESTR_LIVE; no managed connection needed.
 *
 * A public repo with thousands of open issues means collecting >100 issues can
 * only happen by following the `Link: rel="next"` header across pages.
 */
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
