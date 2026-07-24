import type { NormalizedRequest, NormalizedResponse } from '../../core/http/types';
import { FakeTransport, stubAuth } from '../../testing/fakes';
import { MemoryStore } from '../../testing/memory-store';
import { newEmail } from './new-email.polling';

/**
 * Real /me/messages response shape (Microsoft Graph v1.0) — the `{ value: [...] }`
 * envelope with a message carrying from/toRecipients/receivedDateTime, extending
 * the documented example.
 */
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

/** Seed a watermark so the poll runs its real (non-baseline) path. */
async function withWatermark(store: MemoryStore): Promise<void> {
  await store.set('lastPolledAt', '2026-07-20T18:00:00.000Z');
}

describe('outlook.new_email polling trigger', () => {
  it('self-baselines on the first poll: no HTTP call, empty events, watermark recorded', async () => {
    const transport = new FakeTransport(() => okResponse({ value: [MESSAGE_LATE_TASKS] }));
    const store = new MemoryStore();
    const { events } = await newEmail.runPoll({ auth: stubAuth(transport), props: {}, store });

    // INV-2: activation must never backfill the existing inbox.
    expect(events).toEqual([]);
    expect(transport.requests).toHaveLength(0);
    // The SDK records the watermark so only later mail fires.
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
    expect(q).toContain('$orderby=receivedDateTime desc');
    expect(q).toContain('$select=');
    expect(q).toContain('$top=50');
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
