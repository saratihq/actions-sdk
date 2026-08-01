import { defineTrigger } from '../../core/trigger';
import { dropdown, shortText } from '../../core/props';
import { GMAIL_API_BASE, gmailAuth, labelOptions } from './common';

/**
 * Fires once per new message matching the optional Gmail search. Polling, not push: Gmail's only push
 * mechanism (`users.watch`) delivers to a Cloud Pub/Sub topic, never a per-connection URL.
 */

export const GMAIL_NEW_EMAIL_TYPE = 'gmail.new_email';

/** Page size for the list call — the window is paged in full via `nextPageToken`. */
const MAX_RESULTS = 25;
/** Default search when the author gives none — the inbox. */
const DEFAULT_QUERY = 'in:inbox';
/** Subtracted from the watermark before it becomes the `after:` bound; id-dedupe absorbs the re-list. */
const OVERLAP_SECONDS = 120;

/** A normalised "new email" event — headers + snippet, trimmed to what workflows use. */
export interface GmailNewEmailEvent {
  id: string;
  threadId?: string;
  subject?: string;
  /** Raw `From:` header, e.g. `Jane <jane@example.com>`. */
  from?: string;
  /** Raw `Date:` header. */
  date?: string;
  snippet?: string;
  /** Epoch-ms string of the internal receive time. */
  internalDate?: string;
  labelIds: string[];
}

/** A message ref from the list endpoint. */
interface GmailListRef {
  id: string;
  threadId?: string;
}

/** The list response envelope (the fields read). */
interface GmailListResponse {
  messages?: GmailListRef[];
  nextPageToken?: string;
}

/** One `payload.headers[]` entry. */
interface GmailHeader {
  name?: string;
  value?: string;
}

/** The `format=metadata` message response (the fields read). */
interface GmailMetadataMessage {
  id?: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: { headers?: GmailHeader[] };
}

/** Case-insensitive header lookup over the metadata headers array. */
function header(headers: GmailHeader[] | undefined, name: string): string | undefined {
  const lower = name.toLowerCase();
  return headers?.find((h) => (h.name ?? '').toLowerCase() === lower)?.value;
}

/** Transform a metadata message into the normalised event. */
function toEvent(message: GmailMetadataMessage, id: string): GmailNewEmailEvent {
  const headers = message.payload?.headers;
  const subject = header(headers, 'Subject');
  const from = header(headers, 'From');
  const date = header(headers, 'Date');
  return {
    id,
    ...(message.threadId !== undefined ? { threadId: message.threadId } : {}),
    ...(subject !== undefined ? { subject } : {}),
    ...(from !== undefined ? { from } : {}),
    ...(date !== undefined ? { date } : {}),
    ...(message.snippet !== undefined ? { snippet: message.snippet } : {}),
    ...(message.internalDate !== undefined ? { internalDate: message.internalDate } : {}),
    labelIds: message.labelIds ?? [],
  };
}

const props = {
  query: shortText({
    label: 'Search query',
    description: 'A Gmail search, e.g. is:unread. Defaults to in:inbox.',
    required: false,
  }),
  label: dropdown<string, false>({
    label: 'Label',
    description: 'Restrict to a single label — loaded live.',
    required: false,
    options: ({ auth, http }) => labelOptions(http, auth),
  }),
};

export const newEmail = defineTrigger({
  type: GMAIL_NEW_EMAIL_TYPE,
  strategy: 'polling',
  name: 'New email',
  description: 'Fires when a new email matching the search arrives in the connected Gmail mailbox.',
  auth: gmailAuth,
  props,
  sampleData: {
    id: '18f1a2b3c4d5e6f7',
    threadId: '18f1a2b3c4d5e6f7',
    subject: 'Welcome to the team',
    from: 'Jane Doe <jane@example.com>',
    date: 'Mon, 20 Jul 2026 11:20:11 -0700',
    snippet: 'Glad to have you aboard…',
    internalDate: '1784412011000',
    labelIds: ['INBOX', 'UNREAD'],
  },
  async poll({ auth, props: p, http, store, lastPolledAt }): Promise<GmailNewEmailEvent[]> {
    // First-poll baseline: with no watermark, never backfill the mailbox — a failed enable() seed
    // leaves no watermark, so this same baseline runs and a history fan-out stays impossible.
    if (!lastPolledAt) return [];

    const base = p.query && p.query.trim() !== '' ? p.query : DEFAULT_QUERY;
    // Bound by `after:` so a burst larger than one page is paged in full, not truncated to the head window.
    const q = `${base} after:${afterEpochSeconds(lastPolledAt)}`;

    // Skip ids the SDK already emitted; this reads the same set `dedupeKey` populates.
    const seen = new Set((await store.get<string[]>('seen')) ?? []);
    const events: GmailNewEmailEvent[] = [];
    let pageToken: string | undefined;
    do {
      const list = await http.get<GmailListResponse>(`${GMAIL_API_BASE}/messages`, {
        auth,
        query: { q, maxResults: MAX_RESULTS, labelIds: p.label, ...(pageToken ? { pageToken } : {}) },
      });
      for (const ref of list.data.messages ?? []) {
        if (seen.has(ref.id)) continue;
        const res = await http.get<GmailMetadataMessage>(
          `${GMAIL_API_BASE}/messages/${encodeURIComponent(ref.id)}`,
          { auth, query: { format: 'metadata', metadataHeaders: ['Subject', 'From', 'Date'] } },
        );
        events.push(toEvent(res.data, ref.id));
      }
      // Page the whole (`after:`-bounded) window so a multi-page burst is complete.
      pageToken = list.data.nextPageToken;
    } while (pageToken);
    return events;
  },
  /** Dedupe on the immutable Gmail message id. */
  dedupeKey: (event): string => event.id,
});

/** The Gmail `after:` epoch-seconds bound: the last-poll instant, less the overlap margin. */
function afterEpochSeconds(lastPolledAt: string): number {
  const ms = new Date(lastPolledAt).getTime();
  const base = Number.isNaN(ms) ? Date.now() : ms;
  return Math.floor(base / 1000) - OVERLAP_SECONDS;
}
