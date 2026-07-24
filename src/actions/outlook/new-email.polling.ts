import { defineTrigger } from '../../core/trigger';
import type { HttpResponse } from '../../core/http/client';
import type { PropsSchema } from '../../core/props';
import { GRAPH_ME_BASE, MESSAGE_SELECT, type OutlookMessage, outlookAuth } from './common';

/**
 * Polling trigger (`outlook.new_email`) — fires once per new message that arrives
 * in the connected Outlook / Microsoft 365 mailbox.
 *
 * Why polling rather than push: Microsoft Graph supports per-connection change
 * notifications (`POST /subscriptions` on `/me/messages`), but they don't fit the
 * register-per-connection webhook contract in a way that would fire reliably:
 *  - subscriptions on mail resources EXPIRE fast (max ~3 days) and must be RENEWED
 *    on a schedule — the trigger contract offers only `onEnable`/`onDisable`, no
 *    renewal hook, so a subscription would silently lapse and stop firing, and
 *  - notifications carry NO HMAC — the only authenticity signal is echoing a
 *    `clientState` string (plus a validationToken handshake), weaker than the HMAC
 *    the webhook transport verifies, and
 *  - the notification carries only the message id (`resourceData.id`), needing a
 *    follow-up GET anyway.
 * Polling `/me/messages` filtered by `receivedDateTime` + id dedup is robust and
 * never stops firing. It uses the `/me/messages` endpoint, the
 * `$select`/`$filter`/`$orderby`/`$top` OData params, the `@odata.nextLink`
 * cursor, and the `{ value: [message] }` shape from Microsoft Graph v1.0's public
 * API.
 *
 * INV-2 (first-poll baseline): on an EMPTY watermark the poll self-baselines — it
 * returns `[]` and lets the SDK record `lastPolledAt`, so activating the trigger
 * never backfills the existing inbox. Only mail arriving AFTER activation fires
 * (mirrors the gmail/notion/airtable siblings). This holds even if the enable()
 * seed poll failed (a transient 429 / OAuth refresh), because the FIRST real poll
 * is itself the baseline — a history burst is structurally impossible.
 *
 * Completeness: every non-baseline poll PAGES the `receivedDateTime`-bounded window
 * to exhaustion via `@odata.nextLink` (the doc: "apply the entire URL returned in
 * @odata.nextLink to the next get-messages request"), so a burst larger than one
 * `$top` page is never truncated to the newest {@link TOP} — older-but-after-watermark
 * mail below the head window would otherwise be silently dropped. The `$filter`
 * bounds the walk, so paging terminates at the watermark rather than the whole mailbox.
 *
 * Boundary safety: the watermark is widened by a small overlap and compared with
 * `ge` (not a strict `gt` on the exact last-poll wall-clock), so a message landing
 * in the clock-skew / in-flight gap around the poll instant is never skipped; the
 * re-listed boundary message is suppressed by id-dedupe (mirrors the gmail sibling).
 *
 * Docs: https://learn.microsoft.com/en-us/graph/api/user-list-messages?view=graph-rest-1.0
 */

export const OUTLOOK_NEW_EMAIL_TYPE = 'outlook.new_email';

/** Page size for the list call — the window is paged in full via `@odata.nextLink`. */
const TOP = 50;
/**
 * Overlap (seconds) subtracted from the last-poll watermark before it becomes the
 * `receivedDateTime ge` bound, so a message landing around the poll boundary is
 * never skipped; the re-listed overlap is suppressed by id-dedupe.
 */
const OVERLAP_SECONDS = 120;

/** A normalised "new email" event — trimmed to the fields workflows use. */
export interface OutlookNewEmailEvent {
  id: string;
  subject?: string;
  /** Sender display name. */
  fromName?: string;
  /** Sender address. */
  fromAddress?: string;
  receivedDateTime?: string;
  bodyPreview?: string;
  isRead?: boolean;
  hasAttachments?: boolean;
  webLink?: string;
  conversationId?: string;
  /** Recipient addresses on the `To:` line. */
  to: string[];
}

/** The `/me/messages` list response envelope (the fields read). */
interface MessagesListResponse {
  value?: OutlookMessage[];
  /** Absolute URL of the next page; absent/empty on the last page. */
  '@odata.nextLink'?: string;
}

/** Transform a Graph message into the normalised event, or null if it has no id. */
function toEvent(message: OutlookMessage): OutlookNewEmailEvent | null {
  if (!message.id) return null;
  const fromName = message.from?.emailAddress?.name;
  const fromAddress = message.from?.emailAddress?.address;
  return {
    id: message.id,
    ...(message.subject !== undefined ? { subject: message.subject } : {}),
    ...(fromName !== undefined ? { fromName } : {}),
    ...(fromAddress !== undefined ? { fromAddress } : {}),
    ...(message.receivedDateTime !== undefined ? { receivedDateTime: message.receivedDateTime } : {}),
    ...(message.bodyPreview !== undefined ? { bodyPreview: message.bodyPreview } : {}),
    ...(message.isRead !== undefined ? { isRead: message.isRead } : {}),
    ...(message.hasAttachments !== undefined ? { hasAttachments: message.hasAttachments } : {}),
    ...(message.webLink !== undefined ? { webLink: message.webLink } : {}),
    ...(message.conversationId !== undefined ? { conversationId: message.conversationId } : {}),
    to: (message.toRecipients ?? [])
      .map((r) => r.emailAddress?.address)
      .filter((a): a is string => Boolean(a)),
  };
}

export const newEmail = defineTrigger({
  type: OUTLOOK_NEW_EMAIL_TYPE,
  strategy: 'polling',
  name: 'New email',
  description: 'Fires when a new email arrives in the connected Outlook mailbox.',
  auth: outlookAuth,
  props: {} satisfies PropsSchema,
  sampleData: {
    id: 'AAMkAGUAAAwTW09AAA=',
    subject: 'You have late tasks!',
    fromName: 'Microsoft Planner',
    fromAddress: 'noreply@planner.office365.com',
    receivedDateTime: '2026-07-20T18:20:11Z',
    bodyPreview: 'Three tasks are past due…',
    isRead: false,
    hasAttachments: false,
    webLink: 'https://outlook.office365.com/owa/?ItemID=AAMkAGUAAAwTW09AAA%3D',
    conversationId: 'AAQkAGUAAAwTW09AAA=',
    to: ['me@example.com'],
  },
  async poll({ auth, http, lastPolledAt }): Promise<OutlookNewEmailEvent[]> {
    // INV-2 first-poll baseline: with no watermark, don't backfill the mailbox.
    // Return nothing; the SDK records `lastPolledAt` so only mail arriving after
    // activation fires. Guarantees no historical fan-out even if the enable() seed
    // poll failed (a failed seed leaves no watermark → this same baseline runs).
    if (!lastPolledAt) return [];

    // Bound the window to mail at/after the watermark less an overlap, compared with
    // `ge` (not a strict `gt` on the exact instant) so a boundary/in-flight message
    // is never skipped; id-dedupe suppresses the re-listed boundary. $filter and
    // $orderby share receivedDateTime in the same order — Graph's rule for combining
    // them (else it 400s with InefficientFilter).
    const events: OutlookNewEmailEvent[] = [];
    // First page carries the full query; subsequent pages ride the returned
    // @odata.nextLink verbatim (it already encodes $select/$filter/$orderby/$top).
    let url: string | undefined = `${GRAPH_ME_BASE}/messages`;
    let query: Record<string, string | number> | undefined = {
      $select: MESSAGE_SELECT,
      $orderby: 'receivedDateTime desc',
      $top: TOP,
      $filter: `receivedDateTime ge ${sinceWithOverlap(lastPolledAt)}`,
    };
    // Page the whole (watermark-bounded) window to exhaustion so a burst larger than
    // one $top page is never truncated to the newest TOP messages. The $filter bounds
    // the walk, so paging stops at the watermark, not at the whole mailbox.
    while (url) {
      const res: HttpResponse<MessagesListResponse> = await http.get<MessagesListResponse>(url, {
        auth,
        ...(query ? { query } : {}),
      });
      for (const message of res.data.value ?? []) {
        const event = toEvent(message);
        if (event) events.push(event);
      }
      const next = res.data['@odata.nextLink'];
      url = typeof next === 'string' && next.length > 0 ? next : undefined;
      query = undefined;
    }
    return events;
  },
  /** Dedupe on the immutable message id. */
  dedupeKey: (event): string => event.id,
});

/**
 * The `receivedDateTime ge` lower bound: the last-poll instant less the overlap
 * margin, as a Graph datetimeoffset (ISO 8601 UTC). A margin bigger than the poll
 * interval only widens the id-deduped re-list; it never drops mail.
 */
function sinceWithOverlap(lastPolledAt: string): string {
  const ms = new Date(lastPolledAt).getTime();
  const base = Number.isNaN(ms) ? Date.now() : ms;
  return new Date(base - OVERLAP_SECONDS * 1000).toISOString();
}
