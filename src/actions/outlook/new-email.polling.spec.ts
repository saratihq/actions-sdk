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

/** A Graph `/me/messages` stand-in: ascending by receivedDateTime (whole seconds), honouring `ge` and paging by `$skiptoken`. */
function fakeGraph(times: string[]) {
  const messages = times.map((receivedDateTime, i) => ({ id: `msg-${i}`, receivedDateTime }));
  const transport = new FakeTransport((request) => {
    const url = new URL(request.url);
    if (url.searchParams.get('$skiptoken') === 'EXPIRED')
      return { status: 400, headers: {}, data: { error: 'bad token' } };
    const top = Number(url.searchParams.get('$top') ?? 100);
    const skip = url.searchParams.get('$skiptoken');
    const since = Date.parse(url.searchParams.get('$filter')?.replace('receivedDateTime ge ', '') ?? '');
    const start =
      skip !== null ? Number(skip) : messages.findIndex((m) => Date.parse(m.receivedDateTime) >= since);
    const from = start === -1 ? messages.length : start;
    const value = messages.slice(from, from + top);
    const next =
      from + top < messages.length
        ? { '@odata.nextLink': `${url.origin}${url.pathname}?$top=${top}&$skiptoken=${from + top}` }
        : {};
    return okResponse({ value, ...next });
  });
  return Object.assign(transport, { ids: messages.map((m) => m.id), newest: times[times.length - 1]! });
}

/** `count` whole-second timestamps spread over `spanSeconds` from 01:00:00, as Graph reports them. */
function burst(count: number, spanSeconds: number, startSecond = 0): string[] {
  const base = Date.UTC(2026, 9, 1, 1, 0, 0);
  return Array.from({ length: count }, (_, i) =>
    new Date(base + (startSecond + Math.floor((i * spanSeconds) / count)) * 1000)
      .toISOString()
      .replace('.000', ''),
  );
}

/** Poll `times` times, recording what each poll emitted, how many Graph calls it made and the cursor after it. */
async function pollRepeatedly(graph: ReturnType<typeof fakeGraph>, times: number) {
  const store = new MemoryStore();
  await store.set('lastPolledAt', '2026-10-01T00:00:00.000Z');
  const polls: Array<{ events: string[]; calls: number; cursor: string | undefined; first: URL }> = [];
  for (let i = 0; i < times; i += 1) {
    const before = graph.requests.length;
    const { events } = await newEmail.runPoll({ auth: stubAuth(graph), props: {}, store });
    polls.push({
      events: events.map((e) => e.id),
      calls: graph.requests.length - before,
      cursor: await store.get<string>('cursor'),
      first: new URL(graph.requests[before]!.url),
    });
  }
  const cursors = polls.map((p) => Date.parse(p.cursor ?? ''));
  return {
    delivered: polls.flatMap((p) => p.events),
    polls,
    neverBackwards: cursors.every((c, i) => i === 0 || c >= cursors[i - 1]!),
    store,
  };
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

  it('drains a 3,000-message backlog in 500-message polls, each message exactly once, never wedging', async () => {
    const graph = fakeGraph(burst(3000, 3000));
    const { delivered, polls, neverBackwards, store } = await pollRepeatedly(graph, 8);
    expect(delivered).toEqual(graph.ids);
    expect(polls.map((p) => p.events.length)).toEqual([500, 500, 500, 500, 500, 500, 0, 0]);
    expect(neverBackwards).toBe(true);
    expect(await store.get('cursor')).toBe(graph.newest);
    expect(await store.get('resume')).toBeNull();
  });

  it('delivers 1,500 messages that arrived within 115 s exactly once over 12 polls, then stays quiet', async () => {
    const graph = fakeGraph(burst(1500, 115));
    const { delivered, polls, neverBackwards } = await pollRepeatedly(graph, 12);
    expect(delivered).toEqual(graph.ids);
    expect(neverBackwards).toBe(true);
    expect(polls.slice(3).every((p) => p.events.length === 0 && p.calls === 1)).toBe(true);
  });

  it('delivers 600 messages sharing one second, and a later one, all 601 exactly once', async () => {
    const graph = fakeGraph([...burst(600, 1, 5), ...burst(1, 1, 65)]);
    const { delivered, neverBackwards } = await pollRepeatedly(graph, 6);
    expect(delivered).toEqual(graph.ids);
    expect(neverBackwards).toBe(true);
  });

  it('after 600 messages in 60 s, a quiet mailbox costs one Graph call per poll and emits nothing', async () => {
    const graph = fakeGraph(burst(600, 60));
    const { delivered, polls, neverBackwards } = await pollRepeatedly(graph, 8);
    expect(delivered).toEqual(graph.ids);
    expect(neverBackwards).toBe(true);
    expect(polls.slice(2).map((p) => [p.events.length, p.calls])).toEqual(Array(6).fill([0, 1]));
  });

  it('resumes a capped poll from its saved next link, then queries from the cursor once caught up', async () => {
    const graph = fakeGraph(burst(700, 700));
    const { polls } = await pollRepeatedly(graph, 3);
    expect(
      polls.map(
        (p) => p.first.searchParams.get('$filter') ?? `resume ${p.first.searchParams.get('$skiptoken')}`,
      ),
    ).toEqual([
      'receivedDateTime ge 2026-09-30T23:58:00.000Z',
      'resume 500',
      `receivedDateTime ge ${new Date(Date.parse(graph.newest)).toISOString()}`,
    ]);
  });

  it('stops a runaway @odata.nextLink that points at itself, keeps the cursor moving and saves no resume link', async () => {
    const page = burst(100, 100);
    const runaway = 'https://graph.microsoft.com/v1.0/me/messages?$skiptoken=AGAIN';
    const transport = new FakeTransport(() =>
      okResponse({
        value: page.map((t, i) => ({ id: `m${i}`, receivedDateTime: t })),
        '@odata.nextLink': runaway,
      }),
    );
    const store = new MemoryStore();
    await withWatermark(store);
    const { events } = await newEmail.runPoll({ auth: stubAuth(transport), props: {}, store });
    expect(transport.requests.map((r) => r.url.includes('AGAIN'))).toEqual([false, true]);
    expect(events).toHaveLength(100);
    expect(await store.get('cursor')).toBe(page[99]);
    expect(await store.get('resume')).toBeNull();
  });

  it('a saved next link Graph no longer honours costs one poll, then the cursor query delivers the rest', async () => {
    const graph = fakeGraph(burst(700, 700));
    const store = new MemoryStore();
    await store.set('lastPolledAt', '2026-10-01T00:00:00.000Z');
    const first = await newEmail.runPoll({ auth: stubAuth(graph), props: {}, store });
    await store.set('resume', 'https://graph.microsoft.com/v1.0/me/messages?$skiptoken=EXPIRED');
    await expect(newEmail.runPoll({ auth: stubAuth(graph), props: {}, store })).rejects.toMatchObject({
      status: 400,
    });
    const third = await newEmail.runPoll({ auth: stubAuth(graph), props: {}, store });
    expect([...first.events, ...third.events].map((e) => e.id)).toEqual(graph.ids);
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
