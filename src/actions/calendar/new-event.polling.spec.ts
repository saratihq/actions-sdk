import type { NormalizedResponse } from '../../core/http/types';
import { FakeTransport, stubAuth } from '../../testing/fakes';
import { MemoryStore } from '../../testing/memory-store';
import { newEvent } from './new-event.polling';

/**
 * Real events.list response shape (Google Calendar API v3,
 * GET /calendars/{calendarId}/events) — one timed event with attendees, from
 * Google's public reference.
 */
const EVENTS_PAGE = {
  kind: 'calendar#events',
  updated: '2026-07-20T18:03:12.000Z',
  timeZone: 'America/Los_Angeles',
  items: [
    {
      kind: 'calendar#event',
      id: '7f8a9b0c1d2e3f4g',
      status: 'confirmed',
      htmlLink: 'https://www.google.com/calendar/event?eid=abc123',
      created: '2026-07-20T18:03:11.000Z',
      updated: '2026-07-20T18:03:11.234Z',
      summary: 'Design review',
      description: 'Walk through the new flows.',
      location: 'Meet',
      organizer: { email: 'organizer@example.com', displayName: 'Org Anizer' },
      start: { dateTime: '2026-07-22T10:00:00-07:00', timeZone: 'America/Los_Angeles' },
      end: { dateTime: '2026-07-22T10:30:00-07:00', timeZone: 'America/Los_Angeles' },
      attendees: [
        { email: 'guest@example.com', responseStatus: 'needsAction' },
        { email: 'organizer@example.com', organizer: true, responseStatus: 'accepted' },
      ],
    },
  ],
};

const okResponse = (data: unknown): NormalizedResponse => ({ status: 200, headers: {}, data });

/** A watermark comfortably before EVENTS_PAGE's `created`, so its event counts as new. */
const PAST_WATERMARK = '2026-07-20T18:00:00.000Z';

/** Seed a store as if a prior poll had already baselined at `watermark`. */
function storeAt(watermark: string): MemoryStore {
  const store = new MemoryStore();
  void store.set('lastPolledAt', watermark);
  return store;
}

describe('calendar.new_event polling trigger', () => {
  it('self-baselines on the first poll: emits nothing, makes no request, records a watermark', async () => {
    const transport = new FakeTransport(() => okResponse(EVENTS_PAGE));
    const store = new MemoryStore();

    const { events } = await newEvent.runPoll({
      auth: stubAuth(transport),
      props: { calendarId: 'primary' },
      store,
    });

    expect(events).toEqual([]);
    // The pre-existing backlog is never fetched, let alone fired.
    expect(transport.requests).toHaveLength(0);
    expect(typeof store.snapshot().lastPolledAt).toBe('string');
  });

  it('transforms a real events.list payload into a normalised event (once a watermark exists)', async () => {
    const transport = new FakeTransport(() => okResponse(EVENTS_PAGE));
    const { events } = await newEvent.runPoll({
      auth: stubAuth(transport),
      props: { calendarId: 'primary' },
      store: storeAt(PAST_WATERMARK),
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      id: '7f8a9b0c1d2e3f4g',
      status: 'confirmed',
      htmlLink: 'https://www.google.com/calendar/event?eid=abc123',
      summary: 'Design review',
      description: 'Walk through the new flows.',
      location: 'Meet',
      start: { dateTime: '2026-07-22T10:00:00-07:00', timeZone: 'America/Los_Angeles' },
      end: { dateTime: '2026-07-22T10:30:00-07:00', timeZone: 'America/Los_Angeles' },
      created: '2026-07-20T18:03:11.000Z',
      updated: '2026-07-20T18:03:11.234Z',
      organizer: 'organizer@example.com',
      attendees: ['guest@example.com', 'organizer@example.com'],
    });
  });

  it('polls the selected calendar with singleEvents + an overlap-subtracted updatedMin', async () => {
    const transport = new FakeTransport(() => okResponse(EVENTS_PAGE));
    await newEvent.runPoll({
      auth: stubAuth(transport),
      props: { calendarId: 'primary' },
      store: storeAt(PAST_WATERMARK),
    });

    const url = transport.requests[0]!.url;
    expect(url).toContain('https://www.googleapis.com/calendar/v3/calendars/primary/events');
    expect(url).toContain('singleEvents=true');
    expect(url).toContain('orderBy=updated');

    // updatedMin = watermark - 2min overlap → strictly earlier than the watermark.
    const updatedMin = new URL(url).searchParams.get('updatedMin');
    expect(updatedMin).not.toBeNull();
    expect(Date.parse(updatedMin!)).toBe(Date.parse(PAST_WATERMARK) - 2 * 60 * 1000);
  });

  it('drops an EDIT to a pre-existing event, keeping only events created since the watermark', async () => {
    // Both come back on updatedMin (both were just touched); only the second was
    // actually created after the watermark — the first is an old event, re-edited.
    const page = {
      items: [
        {
          ...EVENTS_PAGE.items[0],
          id: 'old-edited',
          created: '2026-01-01T00:00:00.000Z',
          updated: '2026-07-20T18:03:11.500Z',
        },
        {
          ...EVENTS_PAGE.items[0],
          id: 'brand-new',
          created: '2026-07-20T18:03:11.000Z',
          updated: '2026-07-20T18:03:11.234Z',
        },
      ],
    };
    const transport = new FakeTransport(() => okResponse(page));

    const { events } = await newEvent.runPoll({
      auth: stubAuth(transport),
      props: { calendarId: 'primary' },
      store: storeAt(PAST_WATERMARK),
    });

    expect(events.map((e) => e.id)).toEqual(['brand-new']);
  });

  it('pages nextPageToken to exhaustion so the newest event (last page under orderBy=updated) still fires', async () => {
    const firstPage = {
      nextPageToken: 'PAGE2',
      items: [{ ...EVENTS_PAGE.items[0], id: 'older', updated: '2026-07-20T18:03:11.100Z' }],
    };
    const lastPage = {
      items: [{ ...EVENTS_PAGE.items[0], id: 'newest', updated: '2026-07-20T18:03:11.900Z' }],
    };
    const transport = new FakeTransport((_req, i) => okResponse(i === 0 ? firstPage : lastPage));

    const { events } = await newEvent.runPoll({
      auth: stubAuth(transport),
      props: { calendarId: 'primary' },
      store: storeAt(PAST_WATERMARK),
    });

    expect(events.map((e) => e.id)).toEqual(['older', 'newest']);
    expect(transport.requests).toHaveLength(2);
    // The second request carries the token from the first page's response.
    expect(new URL(transport.requests[1]!.url).searchParams.get('pageToken')).toBe('PAGE2');
    // The first request carries none.
    expect(new URL(transport.requests[0]!.url).searchParams.has('pageToken')).toBe(false);
  });

  it('advances the watermark and dedupes by id across polls (boundary re-list is a no-op)', async () => {
    // A just-created event (created ~now) so it survives the *creation* filter on
    // BOTH polls — proving the second suppression is id-dedup, not the time floor.
    const nowIso = new Date().toISOString();
    const recentPage = {
      items: [{ ...EVENTS_PAGE.items[0], id: 'recent-1', created: nowIso, updated: nowIso }],
    };
    // Seed a watermark an hour back so the first poll's floor sits below `created`.
    const store = storeAt(new Date(Date.now() - 60 * 60 * 1000).toISOString());

    const first = await newEvent.runPoll({
      auth: stubAuth(new FakeTransport(() => okResponse(recentPage))),
      props: { calendarId: 'primary' },
      store,
    });
    expect(first.events.map((e) => e.id)).toEqual(['recent-1']);

    // The same event is re-listed within the overlap window on the next poll —
    // id-dedup absorbs it, so it never fires twice.
    const secondTransport = new FakeTransport(() => okResponse(recentPage));
    const second = await newEvent.runPoll({
      auth: stubAuth(secondTransport),
      props: { calendarId: 'primary' },
      store,
    });
    expect(second.events).toEqual([]);
    expect(new URL(secondTransport.requests[0]!.url).searchParams.get('updatedMin')).not.toBeNull();
  });
});
