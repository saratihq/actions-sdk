import type { ApiKeyScheme } from '../../core/auth';
import { defineAction } from '../../core/action';
import { linkHeader, paginate } from '../../core/http/pagination';
import { dropdown, number, shortText } from '../../core/props';

/** Public type — a stable public catalog id. */
export const LIST_ISSUES_TYPE = 'github.list_issues';

/** A PAT/OAuth token on the `Authorization` header; public repos also read fine with a `none` credential. */
export const githubTokenAuth: ApiKeyScheme = {
  type: 'apiKey',
  origins: ['https://api.github.com'],
  in: 'header',
  name: 'Authorization',
  prefix: 'Bearer ',
};

const GITHUB_API_BASE = 'https://api.github.com';
const GITHUB_HEADERS: Record<string, string> = {
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
  // GitHub rejects requests without a User-Agent.
  'user-agent': 'orchestr-actions-sdk',
};
const PAGE_SIZE = 100;
const DEFAULT_MAX_ISSUES = 100;

/** A GitHub issue, trimmed to the fields workflows use. Pull requests are filtered out in `run`. */
export interface GithubIssue {
  id: number;
  number: number;
  title: string;
  state: string;
  html_url: string;
  user: { login: string } | null;
  labels: Array<{ name: string }>;
  created_at: string;
  updated_at: string;
  /** Present only when the "issue" is actually a pull request. */
  pull_request?: unknown;
}

/** A paginated REST read; GitHub paginates via the `Link` header (`rel="next"`), not a body cursor. */
export const listIssues = defineAction({
  type: LIST_ISSUES_TYPE,
  name: 'List issues',
  description: 'List issues in a GitHub repository (pull requests excluded).',
  auth: githubTokenAuth,
  props: {
    owner: shortText({ label: 'Owner', description: 'Repository owner or org.', required: true }),
    repo: shortText({ label: 'Repository', description: 'Repository name.', required: true }),
    state: dropdown<string, false>({
      label: 'State',
      required: false,
      defaultValue: 'open',
      options: [
        { label: 'Open', value: 'open' },
        { label: 'Closed', value: 'closed' },
        { label: 'All', value: 'all' },
      ],
    }),
    limit: number({
      label: 'Maximum issues',
      description: 'Stop after collecting this many issues.',
      required: false,
      defaultValue: DEFAULT_MAX_ISSUES,
    }),
  },
  async run({ auth, props, http }): Promise<{ issues: GithubIssue[]; count: number }> {
    const owner = encodeURIComponent(props.owner);
    const repo = encodeURIComponent(props.repo);
    const collected = await paginate<GithubIssue>({
      http,
      auth,
      url: `${GITHUB_API_BASE}/repos/${owner}/${repo}/issues`,
      query: { state: props.state ?? 'open', per_page: PAGE_SIZE },
      headers: GITHUB_HEADERS,
      extractItems: (res) => (Array.isArray(res.data) ? (res.data as GithubIssue[]) : []),
      nextPage: linkHeader('next'),
      // Over-collect vs. the cap: the endpoint interleaves PRs we drop below.
      maxItems: (props.limit ?? DEFAULT_MAX_ISSUES) * 2,
    });
    // GitHub's issues endpoint includes pull requests; a "list issues" action must not.
    const issues = collected
      .filter((issue) => !issue.pull_request)
      .slice(0, props.limit ?? DEFAULT_MAX_ISSUES);
    return { issues, count: issues.length };
  },
});
