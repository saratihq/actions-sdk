import type { NormalizedRequest, NormalizedResponse } from '../../core/http/types';
import { FakeTransport, stubAuth } from '../../testing/fakes';
import { MemoryStore } from '../../testing/memory-store';
import { newEmail } from './new-email.polling';

/** Real users.messages.list response — refs carry only id + threadId (Gmail API v1). */
const LIST_PAGE = {
  messages: [
    { id: '18f1a2b3c4d5e6f7', threadId: '18f1a2b3c4d5e6f7' },
    { id: '18f0999888777666', threadId: '18f0999888777666' },
  ],
  resultSizeEstimate: 2,
};

/** Real users.messages.get (format=metadata) response — snippet + payload.headers. */
const METADATA: Record<string, unknown> = {
  '18f1a2b3c4d5e6f7': {
    id: '18f1a2b3c4d5e6f7',
    threadId: '18f1a2b3c4d5e6f7',
    labelIds: ['INBOX', 'UNREAD'],
    snippet: 'Glad to have you aboard…',
    internalDate: '1784412011000',
    payload: {
      headers: [
        { name: 'From', value: 'Jane Doe <jane@example.com>' },
        { name: 'Subject', value: 'Welcome to the team' },
        { name: 'Date', value: 'Mon, 20 Jul 2026 11:20:11 -0700' },
      ],
    },
  },
  '18f0999888777666': {
    id: '18f0999888777666',
    threadId: '18f0999888777666',
    labelIds: ['INBOX'],
    snippet: 'Reminder about tomorrow…',
    internalDate: '1784410000000',
    payload: {
      headers: [
        { name: 'From', value: 'ops@example.com' },
        { name: 'Subject', value: 'Standup moved' },
        { name: 'Date', value: 'Mon, 20 Jul 2026 10:46:40 -0700' },
      ],
    },
  },
};

/** A transport that answers the list call, then each metadata get by message id. */
function gmailTransport(): FakeTransport {
  return new FakeTransport((request: NormalizedRequest): NormalizedResponse => {
    const url = request.url;
    if (/\/messages\?/.test(url) || /\/messages$/.test(url.split('?')[0]!)) {
      // The list endpoint is `/messages` (possibly with a query); a get is `/messages/{id}`.
      if (!/\/messages\/[^/?]+/.test(url)) return { status: 200, headers: {}, data: LIST_PAGE };
    }
    const match = /\/messages\/([^/?]+)/.exec(url);
    const id = match ? decodeURIComponent(match[1]!) : '';
    return { status: 200, headers: {}, data: METADATA[id] ?? {} };
  });
}

/** A store already primed with a watermark, so `poll` runs its normal (bounded) read. */
async function primedStore(): Promise<MemoryStore> {
  const store = new MemoryStore();
  await store.set('lastPolledAt', '2026-07-20T00:00:00.000Z');
  return store;
}

describe('gmail.new_email polling trigger', () => {
  it('baselines on the first poll: emits nothing and issues no history read (INV-1)', async () => {
    const transport = gmailTransport();
    const store = new MemoryStore();
    const { events } = await newEmail.runPoll({ auth: stubAuth(transport), props: {}, store });

    // No watermark → pure baseline: zero events and NOT a single list/get call, so
    // activating the trigger never fans out the existing inbox as historical runs.
    expect(events).toEqual([]);
    expect(transport.requests).toHaveLength(0);
    // The SDK records the watermark so the next poll bounds by `after:`.
    expect(typeof store.snapshot().lastPolledAt).toBe('string');
  });

  it('lists then fetches metadata, transforming real payloads into normalised events', async () => {
    const { events } = await newEmail.runPoll({
      auth: stubAuth(gmailTransport()),
      props: {},
      store: await primedStore(),
    });

    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({
      id: '18f1a2b3c4d5e6f7',
      threadId: '18f1a2b3c4d5e6f7',
      subject: 'Welcome to the team',
      from: 'Jane Doe <jane@example.com>',
      date: 'Mon, 20 Jul 2026 11:20:11 -0700',
      snippet: 'Glad to have you aboard…',
      internalDate: '1784412011000',
      labelIds: ['INBOX', 'UNREAD'],
    });
    expect(events[1]!.subject).toBe('Standup moved');
  });

  it('defaults the query to in:inbox and requests only header metadata', async () => {
    const transport = gmailTransport();
    await newEmail.runPoll({ auth: stubAuth(transport), props: {}, store: await primedStore() });

    const listUrl = transport.requests[0]!.url;
    expect(listUrl).toContain('https://gmail.googleapis.com/gmail/v1/users/me/messages');
    expect(decodeURIComponent(listUrl)).toContain('q=in:inbox');

    const getUrl = transport.requests[1]!.url;
    expect(getUrl).toContain('format=metadata');
    expect(getUrl).toContain('metadataHeaders=Subject');
    expect(getUrl).toContain('metadataHeaders=From');
  });

  it('honours a custom query prop', async () => {
    const transport = gmailTransport();
    await newEmail.runPoll({
      auth: stubAuth(transport),
      props: { query: 'is:unread from:boss' },
      store: await primedStore(),
    });
    const q = decodeURIComponent(transport.requests[0]!.url).replace(/\+/g, ' ');
    expect(q).toContain('q=is:unread from:boss');
  });

  it('bounds the second poll with after: and pages the whole window (a burst is not truncated)', async () => {
    const store = new MemoryStore();
    // First (seed) poll establishes the watermark so the next poll bounds by `after:`.
    await newEmail.runPoll({ auth: stubAuth(gmailTransport()), props: {}, store });

    const meta = (id: string): Record<string, unknown> => ({
      id,
      threadId: id,
      labelIds: ['INBOX'],
      snippet: id,
      internalDate: '1',
      payload: { headers: [] },
    });
    // A burst of 3 new messages spread across TWO list pages (page 1 hands back a
    // nextPageToken). The old head-window poll would have stopped at page 1.
    const burst = new FakeTransport((request: NormalizedRequest): NormalizedResponse => {
      const url = request.url;
      const get = /\/messages\/([^/?]+)/.exec(url);
      if (get) return { status: 200, headers: {}, data: meta(decodeURIComponent(get[1]!)) };
      if (/pageToken=P2/.test(url)) {
        return { status: 200, headers: {}, data: { messages: [{ id: 'b3' }] } };
      }
      return {
        status: 200,
        headers: {},
        data: { messages: [{ id: 'b1' }, { id: 'b2' }], nextPageToken: 'P2' },
      };
    });

    const second = await newEmail.runPoll({ auth: stubAuth(burst), props: {}, store });
    expect(second.events.map((e) => e.id)).toEqual(['b1', 'b2', 'b3']);
    // The window is bounded by `after:` (the watermark), not a bare head window.
    expect(decodeURIComponent(burst.requests[0]!.url)).toContain('after:');
    // Both list pages were walked (page 1 + page 2 via nextPageToken).
    const listCalls = burst.requests.filter((r) => !/\/messages\//.test(r.url));
    expect(listCalls).toHaveLength(2);
  });

  it('dedupes by message id and skips re-fetching seen ids on the next poll', async () => {
    const store = new MemoryStore();
    // Baseline (INV-1): the first poll emits nothing and reads no history.
    const baseline = await newEmail.runPoll({ auth: stubAuth(gmailTransport()), props: {}, store });
    expect(baseline.events).toEqual([]);

    // The next poll (watermark set) surfaces the two messages as new events.
    const first = await newEmail.runPoll({ auth: stubAuth(gmailTransport()), props: {}, store });
    expect(first.events.map((e) => e.id)).toEqual(['18f1a2b3c4d5e6f7', '18f0999888777666']);

    const secondTransport = gmailTransport();
    const second = await newEmail.runPoll({ auth: stubAuth(secondTransport), props: {}, store });
    expect(second.events).toEqual([]);
    // One list call, and NO metadata gets — both ids were already seen.
    expect(secondTransport.requests).toHaveLength(1);
  });
});
