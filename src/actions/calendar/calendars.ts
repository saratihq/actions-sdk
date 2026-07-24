import { defineAction } from '../../core/action';
import { type CalendarListEntry, calendarAuth, listCalendarList } from './common';

/** Public action type id — no equivalent existed before, so a new underscore id. */
export const LIST_CALENDARS_TYPE = 'calendar.list_calendars';

/**
 * List the calendars on the connected account. Read-only, and a benign live-smoke
 * action for Calendar — it also underpins the calendar picker on every event action.
 */
export const listCalendars = defineAction({
  type: LIST_CALENDARS_TYPE,
  name: 'List calendars',
  description: 'List the calendars on the connected Google account.',
  auth: calendarAuth,
  props: {},
  async run({ auth, http }): Promise<{ calendars: CalendarListEntry[]; count: number }> {
    const calendars = await listCalendarList(http, auth);
    return { calendars, count: calendars.length };
  },
});
