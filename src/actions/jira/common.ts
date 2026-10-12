import { type AuthHandle, type BasicScheme, transportKind } from '../../core/auth';
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

const SITE_GATEWAYS: ReadonlyArray<readonly [suffix: string, gateway: string]> = [
  ['.atlassian.net', GATEWAY],
  ['.jira.com', GATEWAY],
  ['.atlassian-us-gov-mod.net', GOV_GATEWAY],
];

function invalidInstanceUrl(message: string): ActionError {
  return new ActionError({
    code: 'invalid_input',
    message,
    retryable: false,
    detail: { field: 'instanceUrl' },
  });
}

const CLOUD_EXAMPLES =
  'https://your-domain.atlassian.net, https://your-domain.jira.com or https://your-domain.atlassian-us-gov-mod.net';

function asHttps(instanceUrl: string): { url: URL | null; schemeless: boolean } {
  const trimmed = instanceUrl.trim();
  const schemeless = !/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed);
  const url = parsed(schemeless ? `https://${trimmed}` : trimmed);
  if (url?.protocol === 'http:') url.protocol = 'https:';
  return { url, schemeless };
}

/** Classify a site before any request: its origin, and the gateway of its cloud — so a credential never crosses clouds. */
function classifySite(instanceUrl: string): { origin: string; gateway: string } {
  const { url, schemeless } = asHttps(instanceUrl);
  const cloud =
    url &&
    url.protocol === 'https:' &&
    url.port === '' &&
    !url.username &&
    !url.password &&
    !url.hostname.split('.').includes('')
      ? SITE_GATEWAYS.find(([suffix]) => url.hostname.endsWith(suffix))
      : undefined;
  if (!url || !cloud) {
    throw invalidInstanceUrl(
      schemeless
        ? `instanceUrl "${instanceUrl}" has no https:// and is not a Jira Cloud site address — use e.g. ${CLOUD_EXAMPLES}`
        : `instanceUrl "${instanceUrl}" is not a Jira Cloud site — use e.g. ${CLOUD_EXAMPLES}`,
    );
  }
  return { origin: url.origin, gateway: cloud[1] };
}

/** A Jira REST body; a web page where JSON belongs means the request missed the REST API, so it fails loudly. */
export function jiraJson<T>(res: HttpResponse<T>): T {
  if (res.data === undefined || typeof res.data === 'string') {
    throw new ActionError({
      code: 'provider_error',
      message:
        res.data === undefined
          ? 'Jira returned an empty body where JSON was expected'
          : `Jira answered with ${res.headers['content-type'] ?? 'a non-JSON body'} instead of JSON — set Instance URL to your site, e.g. https://your-domain.atlassian.net`,
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

/** The sites the token can reach; `null` when the credential can't list sites (401/403). Any other failure throws. */
async function listSites(
  http: HttpClient,
  auth: AuthHandle,
  gateway: string,
): Promise<AtlassianResource[] | null> {
  let data: unknown;
  try {
    ({ data } = await http.get<unknown>(`${gateway}/oauth/token/accessible-resources`, { auth }));
  } catch (err) {
    if (!(err instanceof ActionError) || err.code !== 'http_error') throw err;
    if (err.status === 401 || err.status === 403) return null;
    throw new ActionError({
      code: 'http_error',
      message: `Jira's site lookup failed: ${err.message}`,
      status: err.status,
      retryable: err.retryable,
      detail: { provider: 'jira', status: err.status },
      cause: err,
    });
  }
  if (!Array.isArray(data)) {
    throw new ActionError({
      code: 'provider_error',
      message: "Jira's site lookup returned no list",
      status: 502,
      retryable: false,
      detail: { provider: 'jira' },
    });
  }
  return data.filter(
    (r): r is AtlassianResource =>
      typeof r === 'object' &&
      r !== null &&
      typeof (r as AtlassianResource).id === 'string' &&
      typeof (r as AtlassianResource).url === 'string',
  );
}

/** Resolve the REST v3 base: the gateway's `ex/jira/<cloudId>` on OAuth (a bare site URL 401s), else the site itself. */
export async function resolveJiraBase(
  http: HttpClient,
  auth: AuthHandle,
  instanceUrl?: string,
): Promise<string> {
  const site = instanceUrl?.trim() ? classifySite(instanceUrl) : null;
  // A direct API token (Basic) can't list sites: it goes straight to the site, and without one its cloud is unknown.
  if (transportKind(auth) === 'direct' && auth.scheme === 'basic') {
    if (!site)
      throw invalidInstanceUrl(
        'instanceUrl is required for an API-token connection — set it to your Jira site',
      );
    return `${site.origin}${API_PATH}`;
  }
  const gateway = site?.gateway ?? GATEWAY;
  const sites = await listSites(http, auth, gateway);
  if (sites === null) {
    if (site) return `${site.origin}${API_PATH}`;
    throw invalidInstanceUrl('this connection cannot list its Jira sites — set instanceUrl to your site');
  }
  if (sites.length === 0) throw invalidInstanceUrl('this connection reaches no Jira site');
  const reachable = sites.map((s) => normaliseSite(s.url)).join(', ');
  if (site) {
    const matched = sites.find((s) => normaliseSite(s.url) === site.origin);
    if (!matched) {
      throw invalidInstanceUrl(
        `instanceUrl ${site.origin} is not a site this connection can reach — it can reach ${reachable}`,
      );
    }
    return `${gateway}/ex/jira/${matched.id}${API_PATH}`;
  }
  if (sites.length === 1) return `${gateway}/ex/jira/${sites[0]!.id}${API_PATH}`;
  throw invalidInstanceUrl(
    `this connection can reach several Jira sites (${reachable}) — set instanceUrl to the one to use`,
  );
}

/** The "which Jira site" prop: it decides the gateway, and on OAuth which of the token's sites is used. */
export function instanceUrlProp() {
  return shortText<false>({
    label: 'Instance URL',
    description:
      'Your Jira Cloud site, e.g. https://your-domain.atlassian.net (or .jira.com). Needed for an API-token connection and for Government Cloud (https://your-domain.atlassian-us-gov-mod.net); a managed connection that reaches one site can leave it blank.',
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
