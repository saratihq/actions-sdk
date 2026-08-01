import type { ApiKeyScheme, AuthHandle } from '../../core/auth';
import type { HttpClient } from '../../core/http/client';
import type { NextPageFn } from '../../core/http/pagination';
import { paginate } from '../../core/http/pagination';
import type { DropdownOption } from '../../core/props';

/** Shared Calendly (API v2) building blocks: Bearer auth, the resource/collection envelopes, and the cursor. */

export const CALENDLY_API_BASE = 'https://api.calendly.com';

/** Calendly authenticates with a personal access token (or managed OAuth) as a Bearer credential. */
export const calendlyAuth: ApiKeyScheme = {
  type: 'apiKey',
  in: 'header',
  name: 'Authorization',
  prefix: 'Bearer ',
};

/** A Calendly user (the `/users/me` resource), trimmed to what actions use. */
export interface CalendlyUser {
  uri: string;
  name: string;
  email: string;
  scheduling_url: string;
  timezone?: string;
  current_organization: string;
}

/** A Calendly scheduled event, trimmed to the fields workflows read. */
export interface CalendlyScheduledEvent {
  uri: string;
  name: string;
  status: string;
  start_time: string;
  end_time: string;
  event_type?: string;
}

interface Collection<T> {
  collection: T[];
  pagination?: { next_page?: string | null; next_page_token?: string | null };
}

/** Calendly pages via `pagination.next_page` — a fully-formed next URL carried in the body. */
export const calendlyNextPage: NextPageFn = (res) =>
  (res.data as Collection<unknown>).pagination?.next_page ?? null;

/** The last URI segment is Calendly's resource UUID (e.g. a scheduled-event uuid for path calls). */
export function uuidFromUri(uri: string): string {
  return uri.split('/').filter(Boolean).pop() ?? uri;
}

/** Resolve the connected user (needed to scope event-type / scheduled-event reads). */
export async function getCurrentUser(http: HttpClient, auth: AuthHandle): Promise<CalendlyUser> {
  const res = await http.get<{ resource: CalendlyUser }>(`${CALENDLY_API_BASE}/users/me`, { auth });
  return res.data.resource;
}

/** Live scheduled-event picker — resolves the user itself, so it stays prop-independent per the loader contract. */
export async function scheduledEventOptions(
  http: HttpClient,
  auth: AuthHandle,
): Promise<DropdownOption<string>[]> {
  const user = await getCurrentUser(http, auth);
  const events = await paginate<CalendlyScheduledEvent>({
    http,
    auth,
    url: `${CALENDLY_API_BASE}/scheduled_events`,
    query: { user: user.uri, count: 100, sort: 'start_time:desc' },
    extractItems: (res) => (res.data as Collection<CalendlyScheduledEvent>).collection,
    nextPage: calendlyNextPage,
    maxItems: 100,
  });
  return events.map((event) => ({
    label: `${event.name} — ${event.start_time}`,
    value: uuidFromUri(event.uri),
  }));
}
