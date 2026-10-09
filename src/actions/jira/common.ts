import type { AuthHandle, BasicScheme } from '../../core/auth';
import { ActionError } from '../../core/errors';
import type { HttpClient } from '../../core/http/client';
import type { JsonValue } from '../../core/http/types';
import { shortText } from '../../core/props';

/** Shared Jira Cloud REST v3 building blocks: auth, base-URL resolution, and the ADF body shape. */

/** HTTP Basic (`email:apiToken`) on the direct transport, OAuth2 bearer on managed — the transport picks. */
export const jiraAuth: BasicScheme = {
  type: 'basic',
  origins: ['https://api.atlassian.com', 'https://*.atlassian.net'],
};

const API_PATH = '/rest/api/3';

/** OAuth-only site listing; its 401 on the direct/basic transport is the fallback signal in {@link resolveJiraBase}. */
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

/** List the Jira sites the token can reach; never throws — `[]` means "fall back to the site URL". */
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

/** Resolve the REST v3 base: the `ex/jira/<cloudId>` gateway on OAuth (a bare site URL 401s), else `instanceUrl`. */
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

/** The "which Jira site" prop: required for direct/BYO, ignored on managed (see {@link resolveJiraBase}). */
export function instanceUrlProp() {
  return shortText<false>({
    label: 'Instance URL',
    description:
      'Your Jira site, e.g. https://your-domain.atlassian.net. Required for a direct/BYO connection; ignored on a managed connection (resolved from the token).',
    required: false,
  });
}

/** Wrap plain text in a minimal ADF document — Jira rich-text fields reject plain strings. */
export function textToAdf(text: string): JsonValue {
  return {
    version: 1,
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  };
}

/** Shape a project reference: all-digits is an `id`, anything else a `key` (e.g. `ENG`). */
export function projectRef(value: string): JsonValue {
  return /^\d+$/.test(value) ? { id: value } : { key: value };
}

export function namedRef(value: string): JsonValue {
  return /^\d+$/.test(value) ? { id: value } : { name: value };
}
