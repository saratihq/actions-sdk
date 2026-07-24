import { defineTrigger } from '../../core/trigger';
import { shortText } from '../../core/props';
import { mailchimpAuth, mailchimpBaseUrl, serverPrefixProp } from './common';

/**
 * Polling trigger (`mailchimp.new_subscriber`) — fires for each new subscriber
 * added to a Mailchimp audience.
 *
 * STRATEGY CHOICE: Mailchimp does expose per-list webhook registration
 * (`POST /lists/{id}/webhooks`), but its deliveries are `application/x-www-form-
 * urlencoded` with bracket-nested params and carry NO HMAC signature — the only
 * authenticity control Mailchimp offers is a secret embedded in the callback URL.
 * That is structurally incompatible with the SDK's raw-body-HMAC `verify` model,
 * so a webhook trigger here could not be authenticated correctly. The Marketing
 * API cleanly supports a "members, newest opt-in first" read bounded server-side
 * by opt-in time (`since_timestamp_opt`), so polling is the correct-by-construction
 * strategy: fetch members who opted in since the last poll and let the SDK dedupe
 * by member id at the overlap boundary.
 *
 * COMPLETENESS (why paging, not a fixed head window): a single fixed-size head
 * read silently drops opt-ins below the top of the list when MORE members opt in
 * between two polls than the page holds, and `timestamp_opt` is only best-effort
 * ordering — imported/API-added members can carry no opt-in timestamp, so the
 * `sort_dir=DESC` order can't be trusted to float every new member into a fixed
 * window. So the poll PAGES the whole `since_timestamp_opt`-bounded window via the
 * `offset`/`count` cursor (walking to `total_items`, capped by {@link MAX_PAGES}),
 * and leans on the SDK's member-id dedupe — not the sort order — for correctness.
 * The re-listed overlap members are already-seen ids, so they never re-fire.
 * Docs: https://mailchimp.com/developer/marketing/api/list-members/list-members-info/
 *       (query params `sort_field=timestamp_opt`, `since_timestamp_opt`, `offset`,
 *       `count`, response `total_items`).
 *
 * INV-1 (first-poll baseline): on an EMPTY watermark the poll returns `[]` and lets
 * the SDK record `lastPolledAt`, so activating the trigger never backfills the
 * existing audience — only members who opt in AFTER activation fire (mirrors the
 * notion/airtable/drive siblings). This holds even if the reconciler's enable()
 * seed poll failed, because the baseline is the first real poll itself.
 *
 * Mailchimp is region-scoped, so the datacenter prefix rides as a required prop
 * (see this app's `common.ts`); Basic auth (any user + API key) on the direct
 * transport.
 */

export const NEW_SUBSCRIBER_TYPE = 'mailchimp.new_subscriber';

/** Page size for the `offset`/`count` cursor (Mailchimp caps `count` at 1000). */
const PAGE_SIZE = 100;

/**
 * Safety cap on pages walked per poll — bounds worst-case work if a provider
 * ever returns a runaway `total_items`. `PAGE_SIZE * MAX_PAGES` new opt-ins in a
 * single poll interval is far beyond any realistic burst (the `since_timestamp_opt`
 * bound already scopes the window to one interval plus the overlap).
 */
const MAX_PAGES = 20;

/**
 * Re-scan overlap (2 min) subtracted from the watermark before it becomes the
 * `since_timestamp_opt` bound, so a member opting in around the poll boundary is
 * never skipped; the re-listed overlap is suppressed by the SDK's id-dedupe
 * (mirrors the notion trigger).
 */
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
  /**
   * Fetch members who opted in since the last poll, bounded server-side by
   * `since_timestamp_opt`, PAGING the whole bounded window via the `offset`/`count`
   * cursor so a burst larger than one page is never truncated. `sort_dir=DESC` is
   * best-effort ordering only — completeness comes from walking to `total_items`,
   * and the SDK's `runPoll` dedupes by member id, so a member re-listed in the
   * overlap window never re-fires. On the first poll (no watermark) return `[]` so
   * activation self-baselines (the SDK records `lastPolledAt`) instead of
   * backfilling the existing audience.
   */
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
      // Stop when the window is drained: an empty/short page, or once it has
      // collected everything the filtered query reports (`total_items`).
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
