import type { AuthHandle, OAuth2Scheme } from '../../core/auth';
import { ActionError } from '../../core/errors';
import type { HttpClient } from '../../core/http/client';
import { dropdown, type DropdownOption, type DropdownSchema } from '../../core/props';

/**
 * Shared Google Calendar (API v3) building blocks: the events endpoints, `calendarList`, and the
 * event shape. Everything must stay plain JSON on the SDK http client so the managed transport works.
 */

export const CALENDAR_API_BASE = 'https://www.googleapis.com/calendar/v3';

/** Calendar authenticates with an OAuth2 bearer access token, attached by the transport. */
export const calendarAuth: OAuth2Scheme = {
  type: 'oauth2',
  origins: ['https://www.googleapis.com'],
  scopes: ['https://www.googleapis.com/auth/calendar'],
};

/** A start/end point of an event: a timed `dateTime` (RFC3339) or an all-day `date`. */
export interface EventDateTime {
  dateTime?: string;
  date?: string;
  timeZone?: string;
}

/** An event attendee, trimmed to what reads and the create/update shape use. */
export interface EventAttendee {
  email: string;
  displayName?: string;
  responseStatus?: string;
  organizer?: boolean;
  optional?: boolean;
}

/** A calendar event (as returned by get/create/update/list). Fields Google may omit are optional. */
export interface CalendarEvent {
  id: string;
  status?: string;
  htmlLink?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: EventDateTime;
  end?: EventDateTime;
  attendees?: EventAttendee[];
  created?: string;
  updated?: string;
  organizer?: { email?: string; displayName?: string; self?: boolean };
  recurringEventId?: string;
}

/** One entry in the user's calendar list, trimmed to what reads and the picker use. */
export interface CalendarListEntry {
  id: string;
  summary: string;
  description?: string;
  primary?: boolean;
  accessRole?: string;
  timeZone?: string;
}

/** Fetch the user's calendar list — shared by `list_calendars` and the calendar picker. */
export async function listCalendarList(http: HttpClient, auth: AuthHandle): Promise<CalendarListEntry[]> {
  const res = await http.get<{ items?: CalendarListEntry[] }>(`${CALENDAR_API_BASE}/users/me/calendarList`, {
    auth,
  });
  return res.data.items ?? [];
}

/** Live calendar picker — must stay independent of other props, per the loader contract. */
export async function calendarOptions(http: HttpClient, auth: AuthHandle): Promise<DropdownOption<string>[]> {
  const calendars = await listCalendarList(http, auth);
  return calendars.map((cal) => ({
    label: cal.primary ? `${cal.summary} (primary)` : cal.summary,
    value: cal.id,
  }));
}

/** The required, live-picker `calendarId` prop shared by every event action. */
export function calendarIdProp(): DropdownSchema<string, true> {
  return dropdown<string, true>({
    label: 'Calendar',
    description: 'Loaded live from your Google Calendar. Use "primary" for the default calendar.',
    required: true,
    options: ({ auth, http }) => calendarOptions(http, auth),
  });
}

/** Google's API defaults `sendUpdates` to `none`, so attendees are added silently unless it is sent. */
export const SEND_UPDATES_OPTIONS: DropdownOption<string>[] = [
  { label: 'All guests', value: 'all' },
  { label: 'External guests only', value: 'externalOnly' },
  { label: 'No one', value: 'none' },
];

/** The optional, default-`all` `sendUpdates` prop shared by create/update/delete. */
export function sendUpdatesProp(): DropdownSchema<string, false> {
  return dropdown<string, false>({
    label: 'Notify guests',
    description: 'Email the invite/update/cancellation to attendees.',
    required: false,
    options: SEND_UPDATES_OPTIONS,
    defaultValue: 'all',
  });
}

/** Build a `/calendars/{calendarId}/events[/{eventId}]` URL, encoding each segment. */
export function eventsUrl(calendarId: string, eventId?: string): string {
  const base = `${CALENDAR_API_BASE}/calendars/${encodeURIComponent(calendarId)}/events`;
  return eventId ? `${base}/${encodeURIComponent(eventId)}` : base;
}

/** Google requires an end for a timed event; default it to 30 minutes after the start, like the UI. */
const DEFAULT_DURATION_MS = 30 * 60 * 1000;

export function defaultEnd(startIso: string): string {
  return new Date(Date.parse(startIso) + DEFAULT_DURATION_MS).toISOString();
}

/** Coerce `attendees` (email strings or `{ email }` objects) into Google's shape; a bad entry throws. */
export function toAttendees(value: unknown): Array<{ email: string }> {
  if (!Array.isArray(value)) {
    throw new ActionError({
      code: 'invalid_input',
      message: '"attendees" must be an array of email addresses',
      retryable: false,
    });
  }
  return value.map((entry) => {
    if (typeof entry === 'string' && entry.trim() !== '') return { email: entry.trim() };
    if (entry && typeof entry === 'object' && typeof (entry as { email?: unknown }).email === 'string') {
      return { email: (entry as { email: string }).email };
    }
    throw new ActionError({
      code: 'invalid_input',
      message: 'each attendee must be an email string or an object with an "email"',
      retryable: false,
    });
  });
}
