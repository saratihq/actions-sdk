import type { AuthHandle, BasicScheme } from '../../core/auth';
import { ActionError } from '../../core/errors';
import type { HttpClient } from '../../core/http/client';
import type { JsonValue } from '../../core/http/types';
import { shortText } from '../../core/props';

/**
 * Shared Jira Cloud building blocks: the endpoints (`/rest/api/3/*`), the auth,
 * and the Atlassian Document Format body shape are Jira's public REST v3 contract.
 *
 * Jira Cloud is **instance-scoped**, but *how* a call is rooted depends on the
 * transport:
 *
 * - **Direct / BYO** (HTTP-Basic, personal API token) talks straight to the user's
 *   own `https://<site>.atlassian.net/rest/api/3`. The site is connection config,
 *   not a secret, so it rides as the `instanceUrl` prop.
 * - **Managed / 3LO OAuth** (what the managed proxy uses) MUST go through the Atlassian
 *   gateway `https://api.atlassian.com/ex/jira/<cloudId>/rest/api/3` — an OAuth
 *   token against the bare site URL 401s. The `cloudId` is discovered from the
 *   token itself via `accessible-resources`, so `instanceUrl` is optional there.
 *
 * {@link resolveJiraBase} picks the right base per transport; every action resolves
 * it once at the top of `run` instead of assuming the site URL.
 */

/**
 * Jira authenticates with HTTP Basic on the direct transport
 * (`base64(email:apiToken)`) and OAuth2 bearer on the managed transport; the
 * transport attaches whichever the connection carries, so the action code is
 * identical across both.
 */
export const jiraAuth: BasicScheme = { type: 'basic' };

const API_PATH = '/rest/api/3';

/**
 * Atlassian's gateway lists the sites an OAuth token can reach. Absolute URL — on
 * the managed transport it routes through the proxy; on the direct/basic transport
 * it 401s (the endpoint is OAuth-only), which is exactly the signal
 * {@link resolveJiraBase} uses to fall back to the site URL.
 */
const ACCESSIBLE_RESOURCES_URL = 'https://api.atlassian.com/oauth/token/accessible-resources';

/** Root a direct/BYO REST v3 call at the connection's own site, trailing slash tolerated. */
export function jiraBaseUrl(instanceUrl: string): string {
  return `${instanceUrl.replace(/\/+$/, '')}${API_PATH}`;
}

/** One Atlassian site the connected OAuth token can reach (`accessible-resources` entry). */
export interface AtlassianResource {
  /** The `cloudId` — the opaque site id the gateway path is keyed on. */
  id: string;
  /** The site's canonical URL, e.g. `https://your-domain.atlassian.net`. */
  url: string;
  name?: string;
  scopes?: string[];
}

/** Normalise a site URL for comparison: strip trailing slashes and lower-case. */
function normaliseSite(url: string): string {
  return url.replace(/\/+$/, '').toLowerCase();
}

/**
 * List the Jira sites the connected token can reach. Returns `[]` on the
 * direct/basic transport (the endpoint is OAuth-only → 401) or on any failure, so
 * the caller can fall back to the site URL. Never throws.
 */
async function fetchAccessibleResources(http: HttpClient, auth: AuthHandle): Promise<AtlassianResource[]> {
  try {
    const res = await http.get<unknown>(ACCESSIBLE_RESOURCES_URL, { auth, throwOnError: false });
    if (res.status < 200 || res.status >= 300 || !Array.isArray(res.data)) return [];
    return res.data.filter(
      (r): r is AtlassianResource =>
        typeof r === 'object' &&
        r !== null &&
        typeof (r as AtlassianResource).id === 'string' &&
        typeof (r as AtlassianResource).url === 'string',
    );
  } catch {
    return [];
  }
}

/**
 * Resolve the REST v3 base URL for the connected Jira account, per transport.
 *
 * - **Managed / OAuth:** `accessible-resources` returns ≥1 site → route through the
 *   gateway `https://api.atlassian.com/ex/jira/<cloudId>/rest/api/3`. When
 *   `instanceUrl` is given the matching site is chosen, otherwise the first one (the
 *   `cloudId` comes from the token, so `instanceUrl` need not be supplied here).
 * - **Direct / BYO:** `accessible-resources` needs OAuth and returns nothing → fall
 *   back to the user's own `${instanceUrl}/rest/api/3`. `instanceUrl` is therefore
 *   required for a direct/BYO connection and optional on managed.
 */
export async function resolveJiraBase(
  http: HttpClient,
  auth: AuthHandle,
  instanceUrl?: string,
): Promise<string> {
  const sites = await fetchAccessibleResources(http, auth);
  if (sites.length > 0) {
    const matched =
      instanceUrl !== undefined
        ? sites.find((s) => normaliseSite(s.url) === normaliseSite(instanceUrl))
        : undefined;
    const site = matched ?? sites[0]!;
    return `https://api.atlassian.com/ex/jira/${site.id}${API_PATH}`;
  }
  if (instanceUrl !== undefined && instanceUrl.trim().length > 0) {
    return jiraBaseUrl(instanceUrl);
  }
  throw new ActionError({
    code: 'invalid_input',
    message:
      'could not resolve the Jira site: no OAuth-accessible resources and no instanceUrl provided — set instanceUrl for a direct/BYO connection',
    retryable: false,
  });
}

/**
 * The "which Jira site" prop. Optional: required for a direct/BYO connection (the
 * base is rooted at it), but ignored on the managed transport where the site is
 * resolved from the OAuth token — see {@link resolveJiraBase}.
 */
export function instanceUrlProp() {
  return shortText<false>({
    label: 'Instance URL',
    description:
      'Your Jira site, e.g. https://your-domain.atlassian.net. Required for a direct/BYO connection; ignored on a managed connection (resolved from the token).',
    required: false,
  });
}

/**
 * Wrap plain text in the smallest valid Atlassian Document Format document (one
 * paragraph) — Jira rich-text fields (description, comment body) require ADF, not
 * plain text. Returned as {@link JsonValue} so it drops straight into a request body.
 */
export function textToAdf(text: string): JsonValue {
  return {
    version: 1,
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  };
}

/**
 * Jira references a project by numeric `id` or by its human `key` (e.g. `ENG`),
 * and an issue type / priority by `id` or `name`. Without a live picker either is
 * accepted and the reference is shaped as the API expects.
 */
export function projectRef(value: string): JsonValue {
  return /^\d+$/.test(value) ? { id: value } : { key: value };
}

export function namedRef(value: string): JsonValue {
  return /^\d+$/.test(value) ? { id: value } : { name: value };
}
