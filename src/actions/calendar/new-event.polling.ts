import { defineTrigger } from '../../core/trigger';
import { type CalendarEvent, type EventDateTime, calendarAuth, calendarIdProp, eventsUrl } from './common';

/**
 * Fires once per event newly added to a calendar. Polling, not push: `events.watch` channels expire
 * within days and the trigger contract has no renewal hook, so a watch channel would silently die.
 */

export const CALENDAR_NEW_EVENT_TYPE = 'calendar.new_event';

const MAX_RESULTS = 250;

/** Subtracted from the watermark to absorb clock skew; id-dedup makes the re-listed boundary a no-op. */
const WATERMARK_OVERLAP_MS = 2 * 60 * 1000;

/** Runaway guard on `nextPageToken` paging; the normal loop stops when the token runs out. */
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
    // First poll baselines to "now"; firing for the pre-existing backlog would flood the trigger.
    if (!lastPolledAt) {
      await store.set('lastPolledAt', new Date().toISOString());
      return [];
    }

    // The floor for both the `updatedMin` query and the client-side creation filter.
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

    // `updatedMin` filters on last-modified, so edits to old events come back too: keep only
    // events created at/after the floor. A missing `created` counts as new; id-dedup guards repeats.
    return items
      .filter((e) => e.created === undefined || Date.parse(e.created) >= floorMs)
      .map(toEvent)
      .filter((e): e is CalendarNewEvent => e !== null);
  },
  /** Dedupe on the event id — an event edited after creation won't re-fire. */
  dedupeKey: (event): string => event.id,
});
