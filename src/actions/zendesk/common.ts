import type { BasicScheme } from '../../core/auth';
import { hostLabel } from '../../core/http/host-label';
import type { NextPageFn } from '../../core/http/pagination';
import { shortText } from '../../core/props';

/** Declared `basic` for the direct transport (username `{email}/token`); the managed transport attaches its own bearer. */
export const zendeskAuth: BasicScheme = { type: 'basic', origins: ['https://*.zendesk.com'] };

/** Root a Support API call at the account's subdomain. */
export function zendeskBaseUrl(subdomain: string): string {
  return `https://${hostLabel(subdomain, 'subdomain')}.zendesk.com/api/v2`;
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
