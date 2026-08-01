import { defineAction } from '../../core/action';
import { type CalendarListEntry, calendarAuth, listCalendarList } from './common';

/** Public catalog id — stable. */
export const LIST_CALENDARS_TYPE = 'calendar.list_calendars';

/** List the calendars on the connected account; also underpins the calendar picker. */
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
