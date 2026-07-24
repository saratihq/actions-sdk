export {
  CALENDAR_API_BASE,
  type CalendarEvent,
  type CalendarListEntry,
  calendarAuth,
  calendarIdProp,
  calendarOptions,
  defaultEnd,
  type EventAttendee,
  type EventDateTime,
  eventsUrl,
  listCalendarList,
  toAttendees,
} from './common';
export {
  CREATE_EVENT_TYPE,
  createEvent,
  DELETE_EVENT_TYPE,
  type DeleteEventResult,
  deleteEvent,
  GET_EVENT_TYPE,
  getEvent,
  LIST_EVENTS_TYPE,
  listEvents,
  UPDATE_EVENT_TYPE,
  updateEvent,
} from './events';
export { LIST_CALENDARS_TYPE, listCalendars } from './calendars';
export { CALENDAR_NEW_EVENT_TYPE, newEvent, type CalendarNewEvent } from './new-event.polling';

import { listCalendars } from './calendars';
import { createEvent, deleteEvent, getEvent, listEvents, updateEvent } from './events';

/** Every Google Calendar action, for catalog builds and registration. */
export const calendarActions = [
  createEvent,
  listEvents,
  getEvent,
  updateEvent,
  deleteEvent,
  listCalendars,
] as const;
