import { createHash } from 'node:crypto';
import type { BasicScheme } from '../../core/auth';
import { hostLabel } from '../../core/http/host-label';
import { shortText } from '../../core/props';

/** Shared Mailchimp Marketing API `/3.0` building blocks; the host is datacenter-scoped, so `serverPrefix` is a required prop. */

/** HTTP Basic (any username + the API key) on the direct transport; managed attaches its own Bearer. */
export const mailchimpAuth: BasicScheme = { type: 'basic', origins: ['https://*.api.mailchimp.com'] };

/** Root a Marketing API call at the connection's datacenter. */
export function mailchimpBaseUrl(serverPrefix: string): string {
  return `https://${hostLabel(serverPrefix, 'serverPrefix')}.api.mailchimp.com/3.0`;
}

/** The required datacenter-prefix prop every action shares. */
export function serverPrefixProp() {
  return shortText<true>({
    label: 'Server prefix',
    description: 'Your Mailchimp datacenter, e.g. us19 (the suffix on your API key).',
    required: true,
  });
}

/** Mailchimp addresses a member by the MD5 of the lowercased email (the "subscriber hash"). */
export function subscriberHash(email: string): string {
  return createHash('md5').update(email.trim().toLowerCase()).digest('hex');
}

/** A Mailchimp audience (list), trimmed to the fields workflows read. */
export interface MailchimpList {
  id: string;
  name: string;
  stats?: { member_count?: number };
}

/** A Mailchimp list member, trimmed to the fields workflows read. */
export interface MailchimpMember {
  id: string;
  email_address: string;
  status: string;
  merge_fields?: Record<string, unknown>;
}

/** A Mailchimp campaign, trimmed to the fields workflows read. */
export interface MailchimpCampaign {
  id: string;
  type?: string;
  status?: string;
  settings?: { title?: string; subject_line?: string };
}
