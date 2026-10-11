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

function parsed(url: string): URL | null {
  try {
    return new URL(url.trim());
  } catch {
    return null;
  }
}

function siteOrigin(instanceUrl: string): string {
  const url = parsed(instanceUrl);
  if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:')) {
    throw new ActionError({
      code: 'invalid_input',
      message: `instanceUrl "${instanceUrl}" is not your site's URL — use e.g. https://your-domain.atlassian.net`,
      retryable: false,
      detail: { field: 'instanceUrl' },
    });
  }
  return url.origin;
}

/** Government Cloud sites have their own gateway, so their credential never reaches the commercial one. */
function gatewayFor(site: string): string {
  return new URL(site).hostname.endsWith('.atlassian-us-gov-mod.net') ? GOV_GATEWAY : GATEWAY;
}

/** A Jira REST body; a web page where JSON belongs means the request missed the REST API, so it fails loudly. */
export function jiraJson<T>(res: HttpResponse<T>): T {
  if (res.data === undefined || typeof res.data === 'string') {
    throw new ActionError({
      code: 'provider_error',
      message: `Jira answered with ${res.data === undefined ? 'an empty body' : (res.headers['content-type'] ?? 'a non-JSON body')} instead of JSON — set Instance URL to your site, e.g. https://your-domain.atlassian.net`,
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
  return parsed(url)?.origin ?? url;
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

/** Resolve the REST v3 base: the gateway's `ex/jira/<cloudId>` on OAuth (a bare site URL 401s), else the site itself. */
export async function resolveJiraBase(
  http: HttpClient,
  auth: AuthHandle,
  instanceUrl: string,
): Promise<string> {
  const site = siteOrigin(instanceUrl);
  const gateway = gatewayFor(site);
  const sites = await fetchAccessibleResources(http, auth, gateway);
  if (sites.length === 0) return `${site}${API_PATH}`;
  const matched = sites.find((s) => normaliseSite(s.url) === site);
  if (!matched) {
    throw new ActionError({
      code: 'invalid_input',
      message: `instanceUrl ${site} is not a site this connection can reach — it can reach ${sites.map((s) => normaliseSite(s.url)).join(', ')}`,
      retryable: false,
      detail: { field: 'instanceUrl' },
    });
  }
  return `${gateway}/ex/jira/${matched.id}${API_PATH}`;
}

/** The "which Jira site" prop: the site's URL decides the gateway and, on OAuth, which of the token's sites is used. */
export function instanceUrlProp() {
  return shortText<true>({
    label: 'Instance URL',
    description:
      'Your Jira Cloud site, e.g. https://your-domain.atlassian.net (or .jira.com; Government Cloud: https://your-domain.atlassian-us-gov-mod.net).',
    required: true,
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
