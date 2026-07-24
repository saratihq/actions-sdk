import { defineTrigger } from '../../core/trigger';
import { type CalendarEvent, type EventDateTime, calendarAuth, calendarIdProp, eventsUrl } from './common';

/**
 * Polling trigger (`calendar.new_event`) — fires once per event newly added to a
 * Google Calendar.
 *
 * Why polling rather than push: Google Calendar offers a per-connection push
 * channel (`events.watch`), but it is a poor fit for the register-per-connection
 * webhook contract and would not fire reliably:
 *  - the push carries NO signature — the only authenticity signal is echoing back
 *    the `X-Goog-Channel-Token` set on the channel (weaker than the HMAC the
 *    webhook transport verifies), and
 *  - the notification is a content-free "something changed" ping requiring a
 *    follow-up `events.list` sync, and
 *  - channels EXPIRE within days and must be renewed on a schedule — and the
 *    trigger contract exposes only `onEnable`/`onDisable`, no renewal hook, so a
 *    watch channel would silently die and stop firing.
 * Polling `events.list` with an `updatedMin` watermark + id dedup is robust,
 * correct-by-construction, and never stops firing. It uses the
 * `/calendars/{calendarId}/events` endpoint, the
 * `singleEvents`/`orderBy`/`updatedMin`/`pageToken` params, the `created`
 * timestamp field, and the `{ items: [Event], nextPageToken }` response shape.
 *
 * Correctness, from the API doc — three things the endpoint does NOT do:
 *  1. `updatedMin` filters on LAST-MODIFIED time, and there is no creation-time
 *     query param — so an EDIT to a pre-existing event comes back and would fire
 *     `new_event` as if new. The poll fetches on `updatedMin`, then keeps only
 *     events whose `created` timestamp is at/after the watermark (client-side
 *     creation filter).
 *  2. A single page caps at `maxResults`, and with `orderBy=updated` the NEWEST
 *     event sits on the LAST page — so a one-shot fetch drops exactly the event to
 *     fire on. Paging follows `nextPageToken` to exhaustion (id-dedup makes the
 *     boundary re-list a no-op).
 *  3. Clocks skew and an event can land a beat before a poll completes. A small
 *     overlap is subtracted from the watermark before use, so a just-missed event
 *     is re-listed next poll (again, id-dedup absorbs the overlap).
 * First poll self-baselines: with no watermark yet it records "now" and emits
 * nothing, so the trigger fires only for events created AFTER it was enabled,
 * never the pre-existing backlog.
 *
 * Docs: https://developers.google.com/workspace/calendar/api/v3/reference/events/list
 */

export const CALENDAR_NEW_EVENT_TYPE = 'calendar.new_event';

const MAX_RESULTS = 250;

/**
 * Overlap subtracted from the watermark before it becomes `updatedMin` (and the
 * creation-filter floor): absorbs clock skew and an event committed just before the
 * previous poll returned. id-dedup makes the re-listed boundary a no-op.
 */
const WATERMARK_OVERLAP_MS = 2 * 60 * 1000;

/**
 * Runaway guard on `nextPageToken` paging — far above any realistic poll window
 * (50 * 250 = 12,500 events touched between two polls). Only ever trips on a
 * pathological backfill; the normal loop stops when the token runs out.
 */
const MAX_PAGES = 50;

/** A normalised "new event" — the fields workflows branch on and template into. */
export interface CalendarNewEvent {
  id: string;
  status?: string;
  htmlLink?: string;
  summary?: string;
  description?: string;
  location?: string;
  /** Timed (`dateTime`) or all-day (`date`) start/end. */
  start?: EventDateTime;
  end?: EventDateTime;
  created?: string;
  updated?: string;
  /** Organiser email. */
  organizer?: string;
  /** Attendee emails. */
  attendees: string[];
}

/** The `events.list` response envelope (the fields read). */
interface EventsListResponse {
  items?: CalendarEvent[];
  /** Present when more pages follow; absent on the final page. */
  nextPageToken?: string;
}

/** Transform a Calendar event resource into the normalised event, or null if it has no id. */
function toEvent(event: CalendarEvent): CalendarNewEvent | null {
  if (!event.id) return null;
  return {
    id: event.id,
    ...(event.status !== undefined ? { status: event.status } : {}),
    ...(event.htmlLink !== undefined ? { htmlLink: event.htmlLink } : {}),
    ...(event.summary !== undefined ? { summary: event.summary } : {}),
    ...(event.description !== undefined ? { description: event.description } : {}),
    ...(event.location !== undefined ? { location: event.location } : {}),
    ...(event.start !== undefined ? { start: event.start } : {}),
    ...(event.end !== undefined ? { end: event.end } : {}),
    ...(event.created !== undefined ? { created: event.created } : {}),
    ...(event.updated !== undefined ? { updated: event.updated } : {}),
    ...(event.organizer?.email ? { organizer: event.organizer.email } : {}),
    attendees: (event.attendees ?? []).map((a) => a.email).filter((e): e is string => Boolean(e)),
  };
}

const props = { calendarId: calendarIdProp() };

export const newEvent = defineTrigger({
  type: CALENDAR_NEW_EVENT_TYPE,
  strategy: 'polling',
  name: 'New event',
  description: 'Fires when a new event is added to the selected Google Calendar.',
  auth: calendarAuth,
  props,
  sampleData: {
    id: '7f8a9b0c1d2e3f4g',
    status: 'confirmed',
    htmlLink: 'https://www.google.com/calendar/event?eid=abc123',
    summary: 'Design review',
    description: 'Walk through the new flows.',
    location: 'Meet',
    start: { dateTime: '2026-07-22T10:00:00-07:00', timeZone: 'America/Los_Angeles' },
    end: { dateTime: '2026-07-22T10:30:00-07:00', timeZone: 'America/Los_Angeles' },
    created: '2026-07-20T18:03:11.000Z',
    updated: '2026-07-20T18:03:11.000Z',
    organizer: 'organizer@example.com',
    attendees: ['guest@example.com'],
  },
  async poll({ auth, props: p, http, store, lastPolledAt }): Promise<CalendarNewEvent[]> {
    // First poll: no watermark exists yet. Baseline to "now" and emit nothing —
    // firing for the pre-existing backlog would flood a freshly-enabled trigger.
    if (!lastPolledAt) {
      await store.set('lastPolledAt', new Date().toISOString());
      return [];
    }

    // The floor for both the `updatedMin` query and the client-side creation
    // filter. Overlap-subtracted so a skewed/just-missed event is still re-listed.
    const floorMs = Date.parse(lastPolledAt) - WATERMARK_OVERLAP_MS;
    const updatedMin = new Date(floorMs).toISOString();

    // Page to exhaustion: with orderBy=updated the newest event is on the last page.
    const items: CalendarEvent[] = [];
    let pageToken: string | undefined;
    let page = 0;
    do {
      const res = await http.get<EventsListResponse>(eventsUrl(p.calendarId), {
        auth,
        query: {
          singleEvents: true,
          showDeleted: false,
          orderBy: 'updated',
          updatedMin,
          maxResults: MAX_RESULTS,
          pageToken,
        },
      });
      items.push(...(res.data.items ?? []));
      pageToken = res.data.nextPageToken;
      page += 1;
    } while (pageToken && page < MAX_PAGES);

    // `updatedMin` also returns edits to old events; keep only ones actually CREATED
    // at/after the floor. An event with no `created` is treated as new (never drop a
    // possibly-genuine event — id-dedup guards against a repeat).
    return items
      .filter((e) => e.created === undefined || Date.parse(e.created) >= floorMs)
      .map(toEvent)
      .filter((e): e is CalendarNewEvent => e !== null);
  },
  /** Dedupe on the event id — an event edited after creation won't re-fire. */
  dedupeKey: (event): string => event.id,
});
