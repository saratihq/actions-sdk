import type { NormalizedRequest, NormalizedResponse } from '../../core/http/types';
import { FakeTransport, stubAuth } from '../../testing/fakes';
import { MemoryStore } from '../../testing/memory-store';
import { newEmail } from './new-email.polling';

/** A `/me/messages` message in Graph v1.0's `{ value: [...] }` envelope shape. */
const MESSAGE_LATE_TASKS = {
  '@odata.etag': 'W/"CQAAABYAAADHcgC8Hl9tRZ/hc1wEUs1TAAAwR4Hg"',
  id: 'AAMkAGUAAAwTW09AAA=',
  subject: 'You have late tasks!',
  bodyPreview: 'Three tasks are past due…',
  isRead: false,
  hasAttachments: false,
  webLink: 'https://outlook.office365.com/owa/?ItemID=AAMkAGUAAAwTW09AAA%3D',
  conversationId: 'AAQkAGUAAAwTW09AAA=',
  receivedDateTime: '2026-07-20T18:20:11Z',
  from: {
    emailAddress: { name: 'Microsoft Planner', address: 'noreply@planner.office365.com' },
  },
  toRecipients: [{ emailAddress: { name: 'Me', address: 'me@example.com' } }],
};

const MESSAGE_WELCOME = {
  '@odata.etag': 'W/"CQAAABYAAADHcgC8Hl9tRZ/hc1wEUs1TAAAwR4Hh"',
  id: 'AAMkAGUAAAwTW10BBB=',
  subject: 'Welcome aboard',
  bodyPreview: 'Glad to have you…',
  isRead: false,
  hasAttachments: false,
  receivedDateTime: '2026-07-20T18:21:44Z',
  from: { emailAddress: { name: 'HR', address: 'hr@example.com' } },
  toRecipients: [{ emailAddress: { address: 'me@example.com' } }],
};

const okResponse = (data: unknown): NormalizedResponse => ({ status: 200, headers: {}, data });

/** Decode the percent-encoded query and normalise "+"→space back to a readable form. */
const readableQuery = (request: NormalizedRequest): string =>
  decodeURIComponent(request.url).replace(/\+/g, ' ');

/** A Graph `/me/messages` stand-in: ascending by receivedDateTime, honouring `ge` and paging by `$skiptoken`. */
function fakeGraph(count: number) {
  const timeOf = (i: number): string =>
    new Date(Date.UTC(2026, 9, 1, 1, 0, 0) + i * 1000).toISOString().replace('.000', '');
  const messages = Array.from({ length: count }, (_, i) => ({ id: `msg-${i}`, receivedDateTime: timeOf(i) }));
  const transport = new FakeTransport((request) => {
    const url = new URL(request.url);
    const top = Number(url.searchParams.get('$top') ?? 100);
    const skip = url.searchParams.get('$skiptoken');
    const since = url.searchParams.get('$filter')?.replace('receivedDateTime ge ', '') ?? '';
    const start =
      skip !== null
        ? Number(skip)
        : messages.findIndex((m) => Date.parse(m.receivedDateTime) >= Date.parse(since));
    const from = start === -1 ? messages.length : start;
    const value = messages.slice(from, from + top);
    const next =
      from + top < messages.length
        ? { '@odata.nextLink': `${url.origin}${url.pathname}?$top=${top}&$skiptoken=${from + top}` }
        : {};
    return okResponse({ value, ...next });
  });
  return Object.assign(transport, {
    ids: messages.map((m) => m.id),
    newest: timeOf(count - 1),
    timeOf,
  });
}

/** Seed a watermark so the poll runs its real (non-baseline) path. */
async function withWatermark(store: MemoryStore): Promise<void> {
  await store.set('lastPolledAt', '2026-07-20T18:00:00.000Z');
}

describe('outlook.new_email polling trigger', () => {
  it('self-baselines on the first poll: no HTTP call, empty events, watermark recorded', async () => {
    const transport = new FakeTransport(() => okResponse({ value: [MESSAGE_LATE_TASKS] }));
    const store = new MemoryStore();
    const { events } = await newEmail.runPoll({ auth: stubAuth(transport), props: {}, store });

    // Activation must never backfill the existing inbox.
    expect(events).toEqual([]);
    expect(transport.requests).toHaveLength(0);
    expect(store.snapshot().lastPolledAt).toEqual(expect.any(String));
  });

  it('transforms a real Graph messages payload into a normalised event (post-baseline)', async () => {
    const transport = new FakeTransport(() => okResponse({ value: [MESSAGE_LATE_TASKS] }));
    const store = new MemoryStore();
    await withWatermark(store);
    const { events } = await newEmail.runPoll({ auth: stubAuth(transport), props: {}, store });

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
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
    });
  });

  it('filters with `ge` and an overlap-widened lower bound, ordered by receivedDateTime', async () => {
    const transport = new FakeTransport(() => okResponse({ value: [MESSAGE_LATE_TASKS] }));
    const store = new MemoryStore();
    await withWatermark(store);
    await newEmail.runPoll({ auth: stubAuth(transport), props: {}, store });

    const q = readableQuery(transport.requests[0]!);
    expect(transport.requests[0]!.url).toContain('https://graph.microsoft.com/v1.0/me/messages');
    expect(q).toContain('$orderby=receivedDateTime asc');
    expect(q).toContain('$select=');
    expect(q).toContain('$top=100');
    // `ge`, not a strict `gt` — the boundary/in-flight message must not be skipped.
    expect(q).toContain('$filter=receivedDateTime ge ');
    expect(q).not.toContain('receivedDateTime gt ');
    // The bound is the watermark (18:00:00) minus the 120s overlap → 17:58:00.
    expect(q).toContain('receivedDateTime ge 2026-07-20T17:58:00.000Z');
  });

  it('pages the whole window via @odata.nextLink (a >1-page burst is never truncated)', async () => {
    const nextLink =
      'https://graph.microsoft.com/v1.0/me/messages?$select=id&$orderby=receivedDateTime+desc&$top=50&$skiptoken=PAGE2';
    const transport = new FakeTransport((_req, callIndex) =>
      callIndex === 0
        ? okResponse({ value: [MESSAGE_LATE_TASKS], '@odata.nextLink': nextLink })
        : okResponse({ value: [MESSAGE_WELCOME] }),
    );
    const store = new MemoryStore();
    await withWatermark(store);
    const { events } = await newEmail.runPoll({ auth: stubAuth(transport), props: {}, store });

    // Both pages walked; the second-page message (older, below the head window) survives.
    expect(transport.requests).toHaveLength(2);
    expect(transport.requests[1]!.url).toBe(nextLink);
    expect(events.map((e) => e.id)).toEqual(['AAMkAGUAAAwTW09AAA=', 'AAMkAGUAAAwTW10BBB=']);
  });

  it('drains a backlog larger than one poll across polls, each message exactly once, never wedging', async () => {
    const graph = fakeGraph(3000);
    const store = new MemoryStore();
    await store.set('lastPolledAt', '2026-10-01T00:00:00.000Z');
    const delivered: string[] = [];
    let polls = 0;
    for (; polls < 20; polls += 1) {
      const { events } = await newEmail.runPoll({ auth: stubAuth(graph), props: {}, store });
      if (events.length === 0) break;
      delivered.push(...events.map((e) => e.id));
    }
    expect(delivered).toEqual(graph.ids);
    expect(polls).toBe(7);
    expect(await store.get('cursor')).toBe(graph.newest);
    expect(await store.get('draining')).toBe(false);
  });

  it('resumes a capped poll exactly at its cursor, then widens by the overlap once caught up', async () => {
    const graph = fakeGraph(700);
    const store = new MemoryStore();
    await store.set('lastPolledAt', '2026-10-01T00:00:00.000Z');
    await newEmail.runPoll({ auth: stubAuth(graph), props: {}, store });
    await newEmail.runPoll({ auth: stubAuth(graph), props: {}, store });
    await newEmail.runPoll({ auth: stubAuth(graph), props: {}, store });
    const filters = graph.requests
      .filter((r) => !r.url.includes('$skiptoken'))
      .map((r) => new URL(r.url).searchParams.get('$filter'));
    expect(filters).toEqual([
      'receivedDateTime ge 2026-09-30T23:58:00.000Z',
      `receivedDateTime ge ${graph.timeOf(499)}`,
      `receivedDateTime ge ${new Date(Date.parse(graph.newest) - 120_000).toISOString()}`,
    ]);
  });

  it('bounds a runaway @odata.nextLink per poll and still moves the cursor', async () => {
    const page = Array.from({ length: 100 }, (_, i) => ({
      id: `m${i}`,
      receivedDateTime: new Date(Date.UTC(2026, 9, 1, 0, 0, i)).toISOString().replace('.000', ''),
    }));
    const transport = new FakeTransport(() =>
      okResponse({
        value: page,
        '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/messages?$skiptoken=AGAIN',
      }),
    );
    const store = new MemoryStore();
    await withWatermark(store);
    const { events } = await newEmail.runPoll({ auth: stubAuth(transport), props: {}, store });
    expect(transport.requests).toHaveLength(5);
    expect(events).toHaveLength(100);
    expect(await store.get('cursor')).toBe(page[99]!.receivedDateTime);
  });

  it('dedupes the id re-listed inside the overlap window across polls', async () => {
    const store = new MemoryStore();
    await withWatermark(store);

    const first = await newEmail.runPoll({
      auth: stubAuth(new FakeTransport(() => okResponse({ value: [MESSAGE_LATE_TASKS] }))),
      props: {},
      store,
    });
    expect(first.events.map((e) => e.id)).toEqual(['AAMkAGUAAAwTW09AAA=']);

    // Next poll re-lists the same boundary message (overlap) — id-dedupe drops it.
    const second = await newEmail.runPoll({
      auth: stubAuth(new FakeTransport(() => okResponse({ value: [MESSAGE_LATE_TASKS] }))),
      props: {},
      store,
    });
    expect(second.events).toEqual([]);
  });
});
