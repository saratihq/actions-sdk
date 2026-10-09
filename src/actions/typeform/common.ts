import type { AuthHandle, OAuth2Scheme } from '../../core/auth';
import type { HttpClient } from '../../core/http/client';
import type { NextPageFn } from '../../core/http/pagination';
import type { DropdownOption } from '../../core/props';

export const TYPEFORM_API_BASE = 'https://api.typeform.com';

/** Bearer auth; the `webhooks:*` scopes are required or the `new_response` trigger's registration 403s. */
export const typeformAuth: OAuth2Scheme = {
  type: 'oauth2',
  origins: ['https://api.typeform.com'],
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

/** Page-number pagination (Typeform /forms): advance `page` until `page_count`. */
export const pageNumberNext: NextPageFn = (response, currentUrl) => {
  const pageCount = (response.data as { page_count?: number }).page_count ?? 1;
  const current = Number(new URL(currentUrl).searchParams.get('page') ?? '1');
  if (!Number.isFinite(current) || current >= pageCount) return null;
  return withQueryParam(currentUrl, 'page', String(current + 1));
};

/** `before`-token pagination (Typeform /responses): responses are newest-first, so the last item's `token` fetches the next older page. */
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

/** Live form picker, honouring the loader's `search` term. */
export async function formOptions(
  http: HttpClient,
  auth: AuthHandle,
  search?: string,
): Promise<DropdownOption<string>[]> {
  const forms = await listForms(http, auth, search);
  return forms.map((form) => ({ label: form.title || form.id, value: form.id }));
}
