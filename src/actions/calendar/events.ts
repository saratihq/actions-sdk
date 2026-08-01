import { defineAction } from '../../core/action';
import { cursorInBody, paginate } from '../../core/http/pagination';
import type { JsonValue } from '../../core/http/types';
import { dateTime, json, longText, number, shortText } from '../../core/props';
import {
  type CalendarEvent,
  calendarAuth,
  calendarIdProp,
  defaultEnd,
  eventsUrl,
  sendUpdatesProp,
  toAttendees,
} from './common';

/** Public catalog ids — stable; existing plans reference them verbatim. */
export const CREATE_EVENT_TYPE = 'calendar.create_google_calendar_event';
export const LIST_EVENTS_TYPE = 'calendar.google_calendar_get_events';
export const GET_EVENT_TYPE = 'calendar.google_calendar_get_event_by_id';
export const UPDATE_EVENT_TYPE = 'calendar.update_event';
export const DELETE_EVENT_TYPE = 'calendar.delete_event';

/** Build a timed event endpoint (`{ dateTime }`) as a JSON-serialisable object. */
function timed(dateTimeIso: string): Record<string, JsonValue> {
  return { dateTime: dateTimeIso };
}

/** Create an event; RFC3339 times, and `end` defaults to start + 30 minutes. */
export const createEvent = defineAction({
  type: CREATE_EVENT_TYPE,
  name: 'Create event',
  description: 'Create an event on a Google Calendar.',
  auth: calendarAuth,
  props: {
    calendarId: calendarIdProp(),
    title: shortText<true>({ label: 'Title', description: 'Event summary/title.', required: true }),
    start: dateTime<true>({ label: 'Start', description: 'Start time (RFC3339).', required: true }),
    end: dateTime({
      label: 'End',
      description: 'End time (RFC3339); defaults to start + 30 min.',
      required: false,
    }),
    location: shortText({ label: 'Location', required: false }),
    description: longText({ label: 'Description', required: false }),
    attendees: json({
      label: 'Attendees',
      description: 'Array of attendee email addresses.',
      required: false,
    }),
    sendUpdates: sendUpdatesProp(),
  },
  async run({ auth, props, http }): Promise<CalendarEvent> {
    const body: Record<string, JsonValue> = {
      summary: props.title,
      start: timed(props.start),
      end: timed(props.end ?? defaultEnd(props.start)),
    };
    if (props.location !== undefined) body.location = props.location;
    if (props.description !== undefined) body.description = props.description;
    if (props.attendees !== undefined) body.attendees = toAttendees(props.attendees);
    const res = await http.post<CalendarEvent>(eventsUrl(props.calendarId), {
      auth,
      body,
      // Email attendees the invite (defaults to 'all'); else Google adds them silently.
      query: { sendUpdates: props.sendUpdates },
    });
    return res.data;
  },
});

/** List events in an optional window, expanding recurrences into instances, following `nextPageToken`. */
export const listEvents = defineAction({
  type: LIST_EVENTS_TYPE,
  name: 'Get all events',
  description: 'List events on a Google Calendar within a time range.',
  auth: calendarAuth,
  props: {
    calendarId: calendarIdProp(),
    timeMin: dateTime({
      label: 'From',
      description: 'Lower bound on event start (RFC3339).',
      required: false,
    }),
    timeMax: dateTime({ label: 'To', description: 'Upper bound on event start (RFC3339).', required: false }),
    query: shortText({
      label: 'Search',
      description: 'Free-text search across event fields.',
      required: false,
    }),
    limit: number({ label: 'Max results', required: false, defaultValue: 250 }),
  },
  async run({ auth, props, http }): Promise<{ events: CalendarEvent[]; count: number }> {
    const events = await paginate<CalendarEvent>({
      http,
      auth,
      url: eventsUrl(props.calendarId),
      query: {
        timeMin: props.timeMin,
        timeMax: props.timeMax,
        q: props.query,
        singleEvents: true,
        orderBy: 'startTime',
        maxResults: 250,
      },
      extractItems: (res) => (res.data as { items?: CalendarEvent[] }).items ?? [],
      nextPage: cursorInBody({ cursorPath: ['nextPageToken'], cursorParam: 'pageToken' }),
      maxItems: props.limit ?? 250,
    });
    return { events, count: events.length };
  },
});

/** Retrieve a single event by id. Read-only. */
export const getEvent = defineAction({
  type: GET_EVENT_TYPE,
  name: 'Get event by id',
  description: 'Retrieve a Google Calendar event by id.',
  auth: calendarAuth,
  props: {
    calendarId: calendarIdProp(),
    eventId: shortText<true>({ label: 'Event id', required: true }),
  },
  async run({ auth, props, http }): Promise<CalendarEvent> {
    const res = await http.get<CalendarEvent>(eventsUrl(props.calendarId, props.eventId), { auth });
    return res.data;
  },
});

/** Update an event via PATCH — omitted props are left unchanged, never blanked. */
export const updateEvent = defineAction({
  type: UPDATE_EVENT_TYPE,
  name: 'Update event',
  description: 'Update fields of a Google Calendar event.',
  auth: calendarAuth,
  props: {
    calendarId: calendarIdProp(),
    eventId: shortText<true>({ label: 'Event id', required: true }),
    title: shortText({ label: 'Title', required: false }),
    start: dateTime({ label: 'Start', description: 'New start time (RFC3339).', required: false }),
    end: dateTime({ label: 'End', description: 'New end time (RFC3339).', required: false }),
    location: shortText({ label: 'Location', required: false }),
    description: longText({ label: 'Description', required: false }),
    sendUpdates: sendUpdatesProp(),
  },
  async run({ auth, props, http }): Promise<CalendarEvent> {
    const body: Record<string, JsonValue> = {};
    if (props.title !== undefined) body.summary = props.title;
    if (props.start !== undefined) body.start = timed(props.start);
    if (props.end !== undefined) body.end = timed(props.end);
    if (props.location !== undefined) body.location = props.location;
    if (props.description !== undefined) body.description = props.description;
    const res = await http.patch<CalendarEvent>(eventsUrl(props.calendarId, props.eventId), {
      auth,
      body,
      // Email attendees the update (defaults to 'all'); else the change is silent.
      query: { sendUpdates: props.sendUpdates },
    });
    return res.data;
  },
});

/** The delete response — the id of the event that was removed. */
export interface DeleteEventResult {
  deleted: boolean;
  eventId: string;
}

/** Delete an event by id. Google returns 204 No Content → synthesised confirmation. */
export const deleteEvent = defineAction({
  type: DELETE_EVENT_TYPE,
  name: 'Delete event',
  description: 'Delete a Google Calendar event by id.',
  auth: calendarAuth,
  props: {
    calendarId: calendarIdProp(),
    eventId: shortText<true>({ label: 'Event id', required: true }),
    sendUpdates: sendUpdatesProp(),
  },
  async run({ auth, props, http }): Promise<DeleteEventResult> {
    await http.delete(eventsUrl(props.calendarId, props.eventId), {
      auth,
      // Email attendees the cancellation (defaults to 'all'); else it is silent.
      query: { sendUpdates: props.sendUpdates },
    });
    return { deleted: true, eventId: props.eventId };
  },
});
