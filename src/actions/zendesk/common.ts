import type { BasicScheme } from '../../core/auth';
import type { NextPageFn } from '../../core/http/pagination';
import { shortText } from '../../core/props';

/**
 * Shared Zendesk (Support API) building blocks: the `/api/v2` endpoints, the
 * `{ ticket }` / `{ tickets, next_page }` envelopes, and the subdomain-scoped host
 * are Zendesk's public contract. JSON throughout, so writes work.
 *
 * Zendesk is **subdomain-scoped** (`https://<subdomain>.zendesk.com`). The opaque
 * auth handle can't carry that, so it rides as a required `subdomain` prop — which
 * blocks assignee/group pickers until the loader contract can pass set-prop values.
 */

/**
 * BYO Zendesk authenticates with HTTP Basic: username `{email}/token`, password
 * the API token. Managed OAuth attaches a Bearer token server-side instead.
 * Declared `basic` for the direct transport; the managed transport attaches its own.
 */
export const zendeskAuth: BasicScheme = { type: 'basic' };

/** Root a Support API call at the account's subdomain. */
export function zendeskBaseUrl(subdomain: string): string {
  return `https://${subdomain}.zendesk.com/api/v2`;
}

/** The required subdomain prop every action shares. */
export function subdomainProp() {
  return shortText<true>({
    label: 'Subdomain',
    description: 'Your Zendesk subdomain, e.g. acme (from acme.zendesk.com).',
    required: true,
  });
}

/** Zendesk pages via a top-level `next_page` — a fully-formed next URL. */
export const zendeskNextPage: NextPageFn = (res) =>
  (res.data as { next_page?: string | null }).next_page ?? null;

/** A Zendesk ticket, trimmed to the fields workflows read. */
export interface ZendeskTicket {
  id: number;
  subject: string;
  status: string;
  priority?: string | null;
  requester_id?: number;
  assignee_id?: number | null;
  tags?: string[];
  created_at?: string;
  updated_at?: string;
}

/** A Zendesk user, trimmed to the fields workflows read. */
export interface ZendeskUser {
  id: number;
  name: string;
  email?: string;
  role?: string;
}
