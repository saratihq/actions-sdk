import { defineTrigger } from '../../core/trigger';
import { shortText } from '../../core/props';
import { mailchimpAuth, mailchimpBaseUrl, serverPrefixProp } from './common';

/** Polling trigger — fires for each new member of a Mailchimp audience, deduped by member id. */
export const NEW_SUBSCRIBER_TYPE = 'mailchimp.new_subscriber';

/** Page size for the `offset`/`count` cursor (Mailchimp caps `count` at 1000). */
const PAGE_SIZE = 100;

/** Safety cap on pages walked per poll, in case a provider reports a runaway `total_items`. */
const MAX_PAGES = 20;

/** Re-scan overlap on the watermark so a boundary opt-in is never skipped; id-dedupe suppresses the repeat. */
const OVERLAP_MS = 120_000;

/** A member as the list-members endpoint returns it (fields we normalise). */
interface MailchimpMemberRow {
  id: string;
  email_address?: string;
  full_name?: string;
  status?: string;
  timestamp_opt?: string;
  merge_fields?: Record<string, unknown>;
}

/** The list-members response envelope. */
interface MailchimpMembersEnvelope {
  members?: MailchimpMemberRow[];
  total_items?: number;
}

/** A normalised new-subscriber event — what a workflow step receives. */
export interface MailchimpSubscriberEvent {
  /** Mailchimp's member id (MD5 of the lowercased email) — the dedup key. */
  id: string;
  email: string;
  fullName?: string;
  status: string;
  /** ISO timestamp of opt-in, when Mailchimp records one. */
  optedInAt?: string;
  mergeFields?: Record<string, unknown>;
}

export const newSubscriber = defineTrigger({
  type: NEW_SUBSCRIBER_TYPE,
  strategy: 'polling',
  name: 'New subscriber',
  description: 'Fires when a new member subscribes to a Mailchimp audience.',
  auth: mailchimpAuth,
  props: {
    serverPrefix: serverPrefixProp(),
    listId: shortText<true>({
      label: 'Audience id',
      description: 'The Mailchimp audience (list) to watch.',
      required: true,
    }),
  },
  sampleData: {
    id: 'f2a3c4d5e6b7a8f9c0d1e2f3a4b5c6d7',
    email: 'ada@example.com',
    fullName: 'Ada Lovelace',
    status: 'subscribed',
    optedInAt: '2026-07-18T18:17:02+00:00',
    mergeFields: { FNAME: 'Ada', LNAME: 'Lovelace' },
  },
  /** Page the whole `since_timestamp_opt` window (DESC order is best-effort only); no watermark = baseline, emit nothing. */
  async poll({ auth, props, http, lastPolledAt }): Promise<MailchimpSubscriberEvent[]> {
    if (!lastPolledAt) return [];

    const since = new Date(new Date(lastPolledAt).getTime() - OVERLAP_MS).toISOString();
    const url = `${mailchimpBaseUrl(props.serverPrefix)}/lists/${encodeURIComponent(props.listId)}/members`;
    const rows: MailchimpMemberRow[] = [];
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const res = await http.get<MailchimpMembersEnvelope>(url, {
        auth,
        query: {
          status: 'subscribed',
          sort_field: 'timestamp_opt',
          sort_dir: 'DESC',
          since_timestamp_opt: since,
          count: PAGE_SIZE,
          offset: page * PAGE_SIZE,
        },
      });
      const members = res.data.members ?? [];
      rows.push(...members);
      // Window drained: an empty page, or everything the filtered query reports.
      const totalItems = res.data.total_items ?? rows.length;
      if (members.length === 0 || rows.length >= totalItems) break;
    }
    return rows.map((member) => ({
      id: member.id,
      email: member.email_address ?? '',
      ...(member.full_name ? { fullName: member.full_name } : {}),
      status: member.status ?? '',
      ...(member.timestamp_opt ? { optedInAt: member.timestamp_opt } : {}),
      ...(member.merge_fields ? { mergeFields: member.merge_fields } : {}),
    }));
  },
  dedupeKey: (member): string => member.id,
});
