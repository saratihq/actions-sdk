import type { AuthHandle, OAuth2Scheme } from '../../core/auth';
import type { HttpClient } from '../../core/http/client';
import type { NextPageFn } from '../../core/http/pagination';
import type { DropdownOption } from '../../core/props';

/**
 * Shared Typeform building blocks: the `/forms` and `/forms/{id}/responses`
 * endpoints, OAuth2 Bearer auth, the `{ items, page_count, total_items }` list
 * envelope, and the `before`-token response cursor. JSON throughout.
 */

export const TYPEFORM_API_BASE = 'https://api.typeform.com';

/**
 * Typeform authenticates with a personal access token / OAuth token as a Bearer
 * credential. `webhooks:write`/`webhooks:read` are required so the `new_response`
 * trigger's `onEnable` (PUT /forms/{id}/webhooks/{tag}) can register over the
 * OAuth transport — without them Typeform 403s the webhook create.
 * Scopes: https://www.typeform.com/developers/get-started/scopes/
 */
export const typeformAuth: OAuth2Scheme = {
  type: 'oauth2',
  scopes: ['forms:read', 'responses:read', 'webhooks:write', 'webhooks:read'],
};

/** A form as it appears in the forms list (trimmed to what reads + the picker use). */
export interface TypeformFormSummary {
  id: string;
  title: string;
  last_updated_at?: string;
  _links?: { display?: string };
}

/** One field in a form definition. */
export interface TypeformField {
  id: string;
  title: string;
  ref?: string;
  type: string;
  properties?: Record<string, unknown>;
  validations?: Record<string, unknown>;
}

/** A full form definition (as returned by GET /forms/{id}). */
export interface TypeformForm {
  id: string;
  title: string;
  fields?: TypeformField[];
  workspace?: { href?: string };
  theme?: { href?: string };
  _links?: { display?: string };
}

/** One submitted response. */
export interface TypeformResponse {
  landing_id?: string;
  token: string;
  response_id?: string;
  submitted_at?: string;
  metadata?: Record<string, unknown>;
  hidden?: Record<string, unknown>;
  answers?: Array<Record<string, unknown>>;
}

/** The paginated list envelope shared by /forms and /forms/{id}/responses. */
export interface TypeformListEnvelope<T> {
  total_items: number;
  page_count: number;
  items: T[];
}

/** Set (or replace) one query param on a URL, preserving the rest. */
export function withQueryParam(url: string, key: string, value: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set(key, value);
  return parsed.toString();
}

/**
 * Page-number pagination (Typeform /forms): read `page_count` from the body and
 * the current `page` from the URL; advance until the last page.
 */
export const pageNumberNext: NextPageFn = (response, currentUrl) => {
  const pageCount = (response.data as { page_count?: number }).page_count ?? 1;
  const current = Number(new URL(currentUrl).searchParams.get('page') ?? '1');
  if (!Number.isFinite(current) || current >= pageCount) return null;
  return withQueryParam(currentUrl, 'page', String(current + 1));
};

/**
 * `before`-token pagination (Typeform /responses): responses come newest-first;
 * pass the LAST item's `token` as `before` to fetch the next (older) page. Stops
 * on a short page (fewer than `pageSize` items) or a missing token.
 */
export function beforeTokenNext(pageSize: number): NextPageFn {
  return (response, currentUrl) => {
    const items = (response.data as { items?: Array<{ token?: string }> }).items ?? [];
    if (items.length < pageSize) return null;
    const last = items[items.length - 1];
    if (!last?.token) return null;
    return withQueryParam(currentUrl, 'before', last.token);
  };
}

/** Fetch the account's forms — shared by `list_forms` and the form picker. */
export async function listForms(
  http: HttpClient,
  auth: AuthHandle,
  search?: string,
): Promise<TypeformFormSummary[]> {
  const res = await http.get<TypeformListEnvelope<TypeformFormSummary>>(`${TYPEFORM_API_BASE}/forms`, {
    auth,
    query: { page_size: 200, ...(search ? { search } : {}) },
  });
  return res.data.items ?? [];
}

/**
 * Live form picker — independent of any other prop (it lists the account's own
 * forms), so it works under today's loader contract and honours the `search` term.
 */
export async function formOptions(
  http: HttpClient,
  auth: AuthHandle,
  search?: string,
): Promise<DropdownOption<string>[]> {
  const forms = await listForms(http, auth, search);
  return forms.map((form) => ({ label: form.title || form.id, value: form.id }));
}
