import { defineAction } from '../../core/action';
import { paginate } from '../../core/http/pagination';
import { dropdown, number, shortText } from '../../core/props';
import {
  CALENDLY_API_BASE,
  type CalendlyScheduledEvent,
  type CalendlyUser,
  calendlyAuth,
  calendlyNextPage,
  getCurrentUser,
  scheduledEventOptions,
} from './common';

/** Public types — stable public catalog ids. */
export const GET_CURRENT_USER_TYPE = 'calendly.get_current_user';
export const LIST_EVENT_TYPES_TYPE = 'calendly.list_event_types';
export const LIST_SCHEDULED_EVENTS_TYPE = 'calendly.list_scheduled_events';
export const GET_SCHEDULED_EVENT_TYPE = 'calendly.get_scheduled_event';
export const LIST_INVITEES_TYPE = 'calendly.list_event_invitees';
export const CANCEL_EVENT_TYPE = 'calendly.cancel_scheduled_event';

/** A Calendly event type (a bookable meeting), trimmed to the fields workflows read. */
export interface CalendlyEventType {
  uri: string;
  name: string;
  active: boolean;
  duration: number;
  scheduling_url: string;
}

/** A Calendly invitee, trimmed to the fields workflows read. */
export interface CalendlyInvitee {
  uri: string;
  email: string;
  name: string;
  status: string;
  event: string;
}

/** Retrieve the connected user. No inputs. */
export const getCurrentUserAction = defineAction({
  type: GET_CURRENT_USER_TYPE,
  name: 'Get current user',
  description: 'Retrieve the connected Calendly user.',
  auth: calendlyAuth,
  props: {},
  async run({ auth, http }): Promise<CalendlyUser> {
    return getCurrentUser(http, auth);
  },
});

/**
 * List the connected user's event types (bookable meetings). Resolves the user
 * URI itself, so no id input is needed.
 */
export const listEventTypes = defineAction({
  type: LIST_EVENT_TYPES_TYPE,
  name: 'List event types',
  description: "List the connected user's Calendly event types.",
  auth: calendlyAuth,
  props: {
    activeOnly: dropdown<string, false>({
      label: 'Active',
      required: false,
      options: [
        { label: 'Active only', value: 'true' },
        { label: 'All', value: '' },
      ],
    }),
    count: number({ label: 'Max results', required: false, defaultValue: 100 }),
  },
  async run({ auth, props, http }): Promise<{ eventTypes: CalendlyEventType[]; count: number }> {
    const user = await getCurrentUser(http, auth);
    const eventTypes = await paginate<CalendlyEventType>({
      http,
      auth,
      url: `${CALENDLY_API_BASE}/event_types`,
      query: { user: user.uri, active: props.activeOnly === 'true' ? true : undefined, count: 100 },
      extractItems: (res) => (res.data as { collection: CalendlyEventType[] }).collection,
      nextPage: calendlyNextPage,
      maxItems: props.count ?? 100,
    });
    return { eventTypes, count: eventTypes.length };
  },
});

/** List the connected user's scheduled events, optionally by status. */
export const listScheduledEvents = defineAction({
  type: LIST_SCHEDULED_EVENTS_TYPE,
  name: 'List scheduled events',
  description: "List the connected user's Calendly scheduled events.",
  auth: calendlyAuth,
  props: {
    status: dropdown<string, false>({
      label: 'Status',
      required: false,
      options: [
        { label: 'Active', value: 'active' },
        { label: 'Canceled', value: 'canceled' },
      ],
    }),
    count: number({ label: 'Max results', required: false, defaultValue: 50 }),
  },
  async run({ auth, props, http }): Promise<{ events: CalendlyScheduledEvent[]; count: number }> {
    const user = await getCurrentUser(http, auth);
    const events = await paginate<CalendlyScheduledEvent>({
      http,
      auth,
      url: `${CALENDLY_API_BASE}/scheduled_events`,
      query: { user: user.uri, status: props.status, count: 100, sort: 'start_time:desc' },
      extractItems: (res) => (res.data as { collection: CalendlyScheduledEvent[] }).collection,
      nextPage: calendlyNextPage,
      maxItems: props.count ?? 50,
    });
    return { events, count: events.length };
  },
});

/** Retrieve a single scheduled event by uuid. The event picker is live. */
export const getScheduledEvent = defineAction({
  type: GET_SCHEDULED_EVENT_TYPE,
  name: 'Get scheduled event',
  description: 'Retrieve a Calendly scheduled event by uuid.',
  auth: calendlyAuth,
  props: {
    eventUuid: dropdown<string, true>({
      label: 'Event',
      description: 'Loaded live from your recent scheduled events.',
      required: true,
      options: ({ auth, http }) => scheduledEventOptions(http, auth),
    }),
  },
  async run({ auth, props, http }): Promise<CalendlyScheduledEvent> {
    const res = await http.get<{ resource: CalendlyScheduledEvent }>(
      `${CALENDLY_API_BASE}/scheduled_events/${encodeURIComponent(props.eventUuid)}`,
      { auth },
    );
    return res.data.resource;
  },
});

/** List the invitees of a scheduled event. */
export const listEventInvitees = defineAction({
  type: LIST_INVITEES_TYPE,
  name: 'List event invitees',
  description: 'List the invitees of a Calendly scheduled event.',
  auth: calendlyAuth,
  props: {
    eventUuid: dropdown<string, true>({
      label: 'Event',
      required: true,
      options: ({ auth, http }) => scheduledEventOptions(http, auth),
    }),
    count: number({ label: 'Max results', required: false, defaultValue: 100 }),
  },
  async run({ auth, props, http }): Promise<{ invitees: CalendlyInvitee[]; count: number }> {
    const invitees = await paginate<CalendlyInvitee>({
      http,
      auth,
      url: `${CALENDLY_API_BASE}/scheduled_events/${encodeURIComponent(props.eventUuid)}/invitees`,
      query: { count: 100 },
      extractItems: (res) => (res.data as { collection: CalendlyInvitee[] }).collection,
      nextPage: calendlyNextPage,
      maxItems: props.count ?? 100,
    });
    return { invitees, count: invitees.length };
  },
});

/** Cancel a scheduled event with an optional reason (JSON body). */
export const cancelScheduledEvent = defineAction({
  type: CANCEL_EVENT_TYPE,
  name: 'Cancel scheduled event',
  description: 'Cancel a Calendly scheduled event.',
  auth: calendlyAuth,
  props: {
    eventUuid: dropdown<string, true>({
      label: 'Event',
      required: true,
      options: ({ auth, http }) => scheduledEventOptions(http, auth),
    }),
    reason: shortText({ label: 'Reason', required: false }),
  },
  async run({ auth, props, http }): Promise<CalendlyScheduledEvent> {
    const res = await http.post<{ resource: CalendlyScheduledEvent }>(
      `${CALENDLY_API_BASE}/scheduled_events/${encodeURIComponent(props.eventUuid)}/cancellation`,
      { auth, body: { reason: props.reason ?? '' } },
    );
    return res.data.resource;
  },
});
