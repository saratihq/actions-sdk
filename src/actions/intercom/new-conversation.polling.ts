import { defineTrigger } from '../../core/trigger';
import type { JsonValue } from '../../core/http/types';
import { INTERCOM_API_BASE, INTERCOM_HEADERS, intercomAuth } from './common';

/**
 * Polling trigger (`intercom.new_conversation`) — fires when a conversation is
 * created.
 *
 * Why polling, not a registered webhook: Intercom webhook topics
 * (`conversation.user.created`, …) are configured **at the app level** in the
 * developer hub and signed with the app's client secret (`X-Hub-Signature`,
 * SHA-1); there is no public API to register a per-connection webhook with a
 * runtime-provided secret. So the correct-by-construction choice is to poll the
 * Search Conversations endpoint, filtering on `created_at` and deduping by id.
 *
 * Search shape (POST `/conversations/search`, `query.value[]` of
 * `{ field, operator, value }`, `pagination.starting_after` cursor, top-level
 * `sort: { field, order }`) and the conversation object are Intercom's public
 * contract — see
 * https://developers.intercom.com/docs/references/2.11/rest-api/api.intercom.io/conversations/searchconversations
 * and the pagination/sorting/search reference
 * https://developers.intercom.com/docs/build-an-integration/learn-more/rest-apis/pagination-sorting-search .
 * `created_at` is a Unix timestamp in **seconds**; the operator set is
 * `=,!=,IN,NIN,<,>,~,!~,^,$` (no `>=`), so the watermark is applied with `>`.
 *
 * MONOTONIC PAGINATION — the search is sorted **`created_at` ascending**. With
 * no explicit `sort` Intercom defaults to `last_request_at` DESC, which
 * reorders results whenever a conversation sees activity; under the per-poll
 * page cap that can push a quiet-but-new conversation past the last page while
 * the watermark still advances past it — dropping it forever. Ascending
 * `created_at` makes page order and the `maxCreated` watermark advance together,
 * so a burst simply drains oldest-first across polls, never skips.
 */
export const NEW_CONVERSATION_TYPE = 'intercom.new_conversation';

const SEARCH_URL = `${INTERCOM_API_BASE}/conversations/search`;
/**
 * Belt-and-braces re-scan window subtracted from the watermark each poll.
 * NOTE: Intercom **day-rounds** the `created_at` value in search comparisons
 * (the date operand is evaluated at day granularity per the pagination/sorting/
 * search reference), so a 2-second overlap is a *no-op* — it is NOT real
 * same-second boundary protection. Correctness at the second boundary comes
 * from id-dedup (the harness `seen` set), not from this window.
 */
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

    // Self-baseline on the first poll ever. The harness only sets `lastPolledAt`
    // *after* a successful poll, so its absence means this connection has never
    // run: persist the watermark at "now" and emit nothing, so pre-existing
    // history is never delivered as new. Every later poll has `lastPolledAt`
    // set and runs the search below.
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
        // Ascending created_at → monotonic pages + watermark (see file header).
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
