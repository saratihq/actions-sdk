import type { AuthHandle, BasicScheme } from '../../core/auth';
import { ActionError } from '../../core/errors';
import type { HttpClient, HttpResponse } from '../../core/http/client';
import type { JsonValue } from '../../core/http/types';
import { shortText } from '../../core/props';

/** Shared Jira Cloud REST v3 building blocks: auth, base-URL resolution, and the ADF body shape. */

/** HTTP Basic (`email:apiToken`) on the direct transport, OAuth2 bearer on managed — the transport picks. */
export const jiraAuth: BasicScheme = {
  type: 'basic',
  origins: [
    'https://api.atlassian.com',
    'https://*.atlassian.net',
    'https://*.jira.com',
    'https://api.atlassian-us-gov-mod.com',
    'https://*.atlassian-us-gov-mod.net',
  ],
};

const API_PATH = '/rest/api/3';
const GATEWAY = 'https://api.atlassian.com';
const GOV_GATEWAY = 'https://api.atlassian-us-gov-mod.com';

function siteOrigin(instanceUrl: string): string {
  try {
    return new URL(instanceUrl.trim()).origin;
  } catch {
    throw new ActionError({
      code: 'invalid_input',
      message: `instanceUrl "${instanceUrl}" is not a URL — use your site, e.g. https://your-domain.atlassian.net`,
      retryable: false,
      detail: { field: 'instanceUrl' },
    });
  }
}

/** Root a direct/BYO REST v3 call at the site's origin, so a pasted page URL (…/jira/…, …/browse/X-1) still reaches the API. */
export function jiraBaseUrl(instanceUrl: string): string {
  return `${siteOrigin(instanceUrl)}${API_PATH}`;
}

/** Government Cloud sites have their own gateway, so their credential never reaches the commercial one. */
function gatewayFor(instanceUrl: string | undefined): string {
  const host = instanceUrl ? URL.parse(instanceUrl.trim())?.hostname : undefined;
  return host?.endsWith('.atlassian-us-gov-mod.net') ? GOV_GATEWAY : GATEWAY;
}

/** A Jira REST body; a web page where JSON belongs means the request missed the REST API, so it fails loudly. */
export function jiraJson<T>(res: HttpResponse<T>): T {
  if (typeof res.data === 'string') {
    throw new ActionError({
      code: 'provider_error',
      message: `Jira answered with ${res.headers['content-type'] ?? 'a non-JSON body'} instead of JSON — set Instance URL to your site, e.g. https://your-domain.atlassian.net`,
      status: 502,
      retryable: false,
      detail: { provider: 'jira' },
    });
  }
  return res.data;
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

/** Normalise a site URL for comparison: its origin, which ignores case, a trailing slash and any page path. */
function normaliseSite(url: string): string {
  return URL.parse(url.trim())?.origin ?? url;
}

/** List the Jira sites the token can reach; never throws — `[]` means "fall back to the site URL". */
async function fetchAccessibleResources(
  http: HttpClient,
  auth: AuthHandle,
  gateway: string,
): Promise<AtlassianResource[]> {
  try {
    const res = await http.get<unknown>(`${gateway}/oauth/token/accessible-resources`, {
      auth,
      throwOnError: false,
    });
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
  const gateway = gatewayFor(instanceUrl);
  const sites = await fetchAccessibleResources(http, auth, gateway);
  if (sites.length > 0) {
    const matched =
      instanceUrl !== undefined
        ? sites.find((s) => normaliseSite(s.url) === normaliseSite(instanceUrl))
        : undefined;
    const site = matched ?? sites[0]!;
    return `${gateway}/ex/jira/${site.id}${API_PATH}`;
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
      'Your Jira Cloud site, e.g. https://your-domain.atlassian.net (or .jira.com; Government Cloud: https://your-domain.atlassian-us-gov-mod.net). Required for a direct/BYO connection; ignored on a managed connection (resolved from the token).',
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
