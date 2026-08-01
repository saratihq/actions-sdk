import { defineTrigger } from '../../core/trigger';
import type { JsonValue } from '../../core/http/types';
import { INTERCOM_API_BASE, INTERCOM_HEADERS, intercomAuth } from './common';

/** Polling trigger — fires when an Intercom conversation is created (search on `created_at`, dedupe by id). */
export const NEW_CONVERSATION_TYPE = 'intercom.new_conversation';

const SEARCH_URL = `${INTERCOM_API_BASE}/conversations/search`;
/** Re-scan window on the watermark; boundary correctness comes from id-dedup, not this (Intercom day-rounds dates). */
const OVERLAP_SEC = 2;
const PER_PAGE = 100;
/** Per-poll page cap — bounds work; the watermark advances so a burst drains across polls. */
const MAX_PAGES = 10;

/** A normalised new-conversation event — trimmed to the fields workflows use. */
export interface IntercomConversationEvent {
  id: string;
  /** Unix seconds. */
  createdAt: number;
  updatedAt?: number;
  state?: string;
  title?: string;
  /** The initiating part's subject/body (e.g. an inbound email). */
  subject?: string;
  body?: string;
  authorType?: string;
  authorId?: string;
  authorName?: string;
  authorEmail?: string;
}

/** The Intercom conversation shape (the relevant fields). */
interface IntercomConversation {
  id?: string;
  created_at?: number;
  updated_at?: number;
  state?: string;
  title?: string;
  source?: {
    subject?: string;
    body?: string;
    author?: { type?: string; id?: string; name?: string; email?: string };
  };
}

/** The search/list envelope: matched conversations + a `pages.next.starting_after` cursor. */
interface IntercomConversationSearchResponse {
  conversations?: IntercomConversation[];
  total_count?: number;
  pages?: { next?: { starting_after?: string } | null };
}

function toEvent(c: IntercomConversation): IntercomConversationEvent {
  const author = c.source?.author;
  return {
    id: c.id ?? '',
    createdAt: c.created_at ?? 0,
    ...(typeof c.updated_at === 'number' ? { updatedAt: c.updated_at } : {}),
    ...(c.state ? { state: c.state } : {}),
    ...(c.title ? { title: c.title } : {}),
    ...(c.source?.subject ? { subject: c.source.subject } : {}),
    ...(c.source?.body ? { body: c.source.body } : {}),
    ...(author?.type ? { authorType: author.type } : {}),
    ...(author?.id ? { authorId: author.id } : {}),
    ...(author?.name ? { authorName: author.name } : {}),
    ...(author?.email ? { authorEmail: author.email } : {}),
  };
}

export const newConversation = defineTrigger({
  type: NEW_CONVERSATION_TYPE,
  strategy: 'polling',
  name: 'New conversation',
  description: 'Fires when a conversation is created in Intercom.',
  auth: intercomAuth,
  props: {},
  sampleData: {
    id: '1295',
    createdAt: 1663597223,
    updatedAt: 1663597260,
    state: 'open',
    title: 'Question about pricing',
    subject: 'Question about pricing',
    body: '<p>Hi, I have a question…</p>',
    authorType: 'contact',
    authorId: '274',
    authorName: 'John Smith',
    authorEmail: 'customer@example.com',
  },
  async poll({ auth, http, store, lastPolledAt }): Promise<IntercomConversationEvent[]> {
    const nowSec = Math.floor(Date.now() / 1000);

    // First poll ever (no `lastPolledAt`): baseline the watermark and emit nothing, so history isn't delivered as new.
    if (lastPolledAt === undefined) {
      await store.set('cursor', nowSec);
      return [];
    }

    const stored = await store.get<number>('cursor');
    const baseSec = stored ?? nowSec;
    const sinceSec = Math.max(0, baseSec - OVERLAP_SEC);
    let maxCreated = baseSec;
    let startingAfter: string | undefined;
    const collected: IntercomConversation[] = [];

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const pagination: Record<string, JsonValue> = { per_page: PER_PAGE };
      if (startingAfter !== undefined) pagination.starting_after = startingAfter;
      const body: Record<string, JsonValue> = {
        query: {
          operator: 'AND',
          // Intercom's date operand is a string (docs); day-rounded on compare.
          value: [{ field: 'created_at', operator: '>', value: String(sinceSec) }],
        },
        // Must stay ascending: the last_request_at DESC default reorders pages and can skip a new conversation.
        sort: { field: 'created_at', order: 'ascending' },
        pagination,
      };
      const res = await http.post<IntercomConversationSearchResponse>(SEARCH_URL, {
        auth,
        headers: INTERCOM_HEADERS,
        body,
      });
      const results = res.data.conversations ?? [];
      collected.push(...results);
      for (const c of results) {
        if (typeof c.created_at === 'number' && c.created_at > maxCreated) maxCreated = c.created_at;
      }
      const next = res.data.pages?.next?.starting_after;
      if (!next || results.length === 0) break;
      startingAfter = next;
    }

    await store.set('cursor', maxCreated);
    return collected.map(toEvent);
  },
  dedupeKey: (event): string => event.id,
});
