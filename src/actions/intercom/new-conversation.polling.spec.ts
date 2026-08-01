import type { NormalizedResponse } from '../../core/http/types';
import { FakeTransport, stubAuth } from '../../testing/fakes';
import { MemoryStore } from '../../testing/memory-store';
import { newConversation } from './new-conversation.polling';

/** A conversations-search response, in Intercom's public envelope shape. */
function searchResponse(): NormalizedResponse {
  return {
    status: 200,
    headers: {},
    data: {
      type: 'conversation.list',
      conversations: [
        {
          type: 'conversation',
          id: '1295',
          title: 'Question about pricing',
          created_at: 1663597223,
          updated_at: 1663597260,
          state: 'open',
          source: {
            type: 'email',
            subject: 'Question about pricing',
            body: '<p>Hi, I have a question…</p>',
            author: { type: 'contact', id: '274', name: 'John Smith', email: 'customer@example.com' },
          },
        },
      ],
      total_count: 1,
      pages: { type: 'pages', page: 1, per_page: 20, total_pages: 1 },
    },
  };
}

describe('intercom.new_conversation — polling', () => {
  it('self-baselines on the first poll: no search, no events, watermark persisted', async () => {
    const transport = new FakeTransport(() => searchResponse());
    const store = new MemoryStore();

    const first = await newConversation.runPoll({ auth: stubAuth(transport), props: {}, store });

    expect(first.events).toEqual([]);
    expect(transport.requests).toHaveLength(0); // history is never backfilled as "new"
    expect(await store.get('cursor')).toEqual(expect.any(Number));
  });

  it('POSTs a created_at query sorted ascending, with the pinned API version', async () => {
    const transport = new FakeTransport(() => searchResponse());
    const auth = stubAuth(transport);
    const store = new MemoryStore();

    await newConversation.runPoll({ auth, props: {}, store }); // baseline poll
    await newConversation.runPoll({ auth, props: {}, store }); // real search poll

    const sent = transport.requests[0];
    expect(sent?.method).toBe('POST');
    expect(sent?.url).toBe('https://api.intercom.io/conversations/search');
    expect(sent?.headers['intercom-version']).toBe('2.11');
    const body = sent?.body as {
      query: { operator: string; value: Array<{ field: string; operator: string; value: string }> };
      sort: { field: string; order: string };
      pagination: { per_page: number };
    };
    expect(body.query.operator).toBe('AND');
    expect(body.query.value[0]?.field).toBe('created_at');
    expect(body.query.value[0]?.operator).toBe('>');
    expect(typeof body.query.value[0]?.value).toBe('string'); // unix-seconds string
    // Monotonic pagination: ascending created_at, not the last_request_at DESC default.
    expect(body.sort).toEqual({ field: 'created_at', order: 'ascending' });
    expect(body.pagination.per_page).toBe(100);
  });

  it('transforms a real conversation payload into a normalised event', async () => {
    const transport = new FakeTransport(() => searchResponse());
    const auth = stubAuth(transport);
    const store = new MemoryStore();

    await newConversation.runPoll({ auth, props: {}, store }); // baseline poll
    const result = await newConversation.runPoll({ auth, props: {}, store });

    expect(result.events).toEqual([
      {
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
    ]);
  });

  it('dedupes by conversation id across polls', async () => {
    const transport = new FakeTransport(() => searchResponse());
    const auth = stubAuth(transport);
    const store = new MemoryStore();

    await newConversation.runPoll({ auth, props: {}, store }); // baseline poll

    const first = await newConversation.runPoll({ auth, props: {}, store });
    expect(first.events.map((e) => e.id)).toEqual(['1295']);

    const second = await newConversation.runPoll({ auth, props: {}, store });
    expect(second.events).toEqual([]);
  });
});
