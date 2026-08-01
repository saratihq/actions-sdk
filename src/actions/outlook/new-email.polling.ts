import { defineTrigger } from '../../core/trigger';
import type { HttpResponse } from '../../core/http/client';
import type { PropsSchema } from '../../core/props';
import { GRAPH_ME_BASE, MESSAGE_SELECT, type OutlookMessage, outlookAuth } from './common';

/** Polling trigger — fires once per new message in the connected Outlook mailbox, deduped by message id. */
export const OUTLOOK_NEW_EMAIL_TYPE = 'outlook.new_email';

/** Page size for the list call — the window is paged in full via `@odata.nextLink`. */
const TOP = 50;
/** Overlap on the watermark so a boundary message is never skipped; id-dedupe suppresses the re-list. */
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
    // First poll ever: baseline the watermark and emit nothing, so the existing mailbox isn't backfilled.
    if (!lastPolledAt) return [];

    // $filter and $orderby must share receivedDateTime in the same order, or Graph 400s with InefficientFilter.
    const events: OutlookNewEmailEvent[] = [];
    // Only the first page carries a query; later pages ride @odata.nextLink verbatim.
    let url: string | undefined = `${GRAPH_ME_BASE}/messages`;
    let query: Record<string, string | number> | undefined = {
      $select: MESSAGE_SELECT,
      $orderby: 'receivedDateTime desc',
      $top: TOP,
      $filter: `receivedDateTime ge ${sinceWithOverlap(lastPolledAt)}`,
    };
    // Page the watermark-bounded window to exhaustion so a burst larger than one page isn't truncated.
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

/** The `receivedDateTime ge` lower bound: the last-poll instant less the overlap, as ISO 8601 UTC. */
function sinceWithOverlap(lastPolledAt: string): string {
  const ms = new Date(lastPolledAt).getTime();
  const base = Number.isNaN(ms) ? Date.now() : ms;
  return new Date(base - OVERLAP_SECONDS * 1000).toISOString();
}
