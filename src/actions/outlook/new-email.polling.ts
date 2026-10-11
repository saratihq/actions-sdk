import type { HttpResponse } from '../../core/http/client';
import { appendQuery } from '../../core/http/types';
import type { PropsSchema } from '../../core/props';
import { defineTrigger } from '../../core/trigger';
import { GRAPH_ME_BASE, MESSAGE_SELECT, odataNextLink, type OutlookMessage, outlookAuth } from './common';

/** Polling trigger — fires once per new message in the connected Outlook mailbox, deduped by message id. */
export const OUTLOOK_NEW_EMAIL_TYPE = 'outlook.new_email';

/** Page size for the list call; Graph allows up to 1000. */
const TOP = 100;
/** Messages newer than the cursor emitted per poll — half the trigger's dedupe memory; a larger backlog drains over later polls. */
const MAX_PER_POLL = 500;
/** Pages read per poll; a poll that stops early saves its next link and the next poll resumes there. */
const MAX_PAGES_PER_POLL = 20;
/** Messages can become visible after their receivedDateTime; re-list this far behind the previous poll, id-dedupe drops repeats. */
const OVERLAP_MS = 120_000;

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
  async poll({ auth, http, store, lastPolledAt }): Promise<OutlookNewEmailEvent[]> {
    // First poll ever: baseline the watermark and emit nothing, so the existing mailbox isn't backfilled.
    if (!lastPolledAt) return [];

    const cursor = (await store.get<string>('cursor')) ?? lastPolledAt;
    const reached = Date.parse(cursor);
    // Cleared before use, so a link Graph no longer honours costs one failed poll, then the cursor query takes over.
    const resume = await store.get<string | null>('resume');
    await store.set('resume', null);

    // $filter and $orderby must share receivedDateTime in the same order, or Graph 400s with InefficientFilter.
    let url: string | null =
      resume ??
      appendQuery(`${GRAPH_ME_BASE}/messages`, {
        $select: MESSAGE_SELECT,
        $orderby: 'receivedDateTime asc',
        $top: TOP,
        $filter: `receivedDateTime ge ${lowerBound(reached, lastPolledAt)}`,
      });
    const messages: OutlookMessage[] = [];
    let fresh = 0;
    for (let page = 0; url && page < MAX_PAGES_PER_POLL && fresh < MAX_PER_POLL; page += 1) {
      const res: HttpResponse<MessagesListResponse> = await http.get<MessagesListResponse>(url, { auth });
      for (const message of res.data.value ?? []) {
        messages.push(message);
        if (Date.parse(message.receivedDateTime ?? '') > reached) fresh += 1;
      }
      const next = odataNextLink(res, url);
      url = next === url ? null : next;
    }
    if (url) await store.set('resume', url);

    const newest = messages.reduce<string | undefined>(
      (max, m) =>
        m.receivedDateTime && Date.parse(m.receivedDateTime) > Date.parse(max ?? cursor)
          ? m.receivedDateTime
          : max,
      undefined,
    );
    if (newest) await store.set('cursor', newest);
    return messages.map(toEvent).filter((event): event is OutlookNewEmailEvent => event !== null);
  },
  /** Dedupe on the immutable message id. */
  dedupeKey: (event): string => event.id,
});

/** The `receivedDateTime ge` lower bound: the cursor, or the overlap behind the previous poll if that is earlier. */
function lowerBound(reached: number, lastPolledAt: string): string {
  const polled = Date.parse(lastPolledAt);
  const overlapStart = (Number.isNaN(polled) ? Date.now() : polled) - OVERLAP_MS;
  return new Date(Number.isNaN(reached) ? overlapStart : Math.min(reached, overlapStart)).toISOString();
}
