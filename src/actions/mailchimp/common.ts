import { createHash } from 'node:crypto';
import type { BasicScheme } from '../../core/auth';
import { shortText } from '../../core/props';

/**
 * Shared Mailchimp (Marketing API) building blocks: the `/3.0` endpoints, the
 * datacenter-prefixed host, and the `merge_fields`/subscriber-hash conventions
 * are Mailchimp's public contract. JSON throughout, so writes work.
 *
 * Mailchimp is **region-scoped**: the host embeds a datacenter prefix (e.g.
 * `us19`) taken from the API-key suffix or the OAuth metadata endpoint. The
 * opaque auth handle can't carry it, so it rides as a required `serverPrefix`
 * prop — which means audience/list pickers are blocked until the loader contract
 * can pass set-prop values.
 */

/**
 * BYO Mailchimp API keys authenticate with HTTP Basic (any username + the key as
 * password); managed OAuth attaches a Bearer token server-side instead. Declared
 * `basic` for the direct transport; the managed transport attaches its own
 * credential.
 */
export const mailchimpAuth: BasicScheme = { type: 'basic' };

/** Root a Marketing API call at the connection's datacenter. */
export function mailchimpBaseUrl(serverPrefix: string): string {
  return `https://${serverPrefix}.api.mailchimp.com/3.0`;
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
