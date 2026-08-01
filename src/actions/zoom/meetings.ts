import { defineAction } from '../../core/action';
import { cursorInBody, paginate } from '../../core/http/pagination';
import type { JsonValue } from '../../core/http/types';
import { dateTime, dropdown, longText, number, shortText } from '../../core/props';
import { userIdProp, ZOOM_API_BASE, type ZoomMeeting, type ZoomMeetingListEntry, zoomAuth } from './common';

/** Public types — stable public catalog ids. */
export const CREATE_MEETING_TYPE = 'zoom.zoom_create_meeting';
export const LIST_MEETINGS_TYPE = 'zoom.list_meetings';
export const GET_MEETING_TYPE = 'zoom.zoom_find_meeting';
export const UPDATE_MEETING_TYPE = 'zoom.zoom_update_meeting';
export const DELETE_MEETING_TYPE = 'zoom.delete_meeting';

/** Zoom's meeting-type enum, surfaced as a static picker. */
function meetingTypeProp() {
  return dropdown<number, false>({
    label: 'Type',
    required: false,
    defaultValue: 2,
    options: [
      { label: 'Scheduled', value: 2 },
      { label: 'Instant', value: 1 },
      { label: 'Recurring (no fixed time)', value: 3 },
      { label: 'Recurring (fixed time)', value: 8 },
    ],
  });
}

/** Create a meeting for a host (blank `userId` = the connected user); `start_time`/`duration` apply to a scheduled meeting. */
export const createMeeting = defineAction({
  type: CREATE_MEETING_TYPE,
  name: 'Create Zoom meeting',
  description: 'Create a Zoom meeting for a host.',
  auth: zoomAuth,
  props: {
    userId: userIdProp(),
    topic: shortText<true>({ label: 'Topic', required: true }),
    type: meetingTypeProp(),
    start_time: dateTime({
      label: 'Start time',
      description: 'Start time for a scheduled meeting (RFC3339).',
      required: false,
    }),
    duration: number({ label: 'Duration (minutes)', required: false }),
    timezone: shortText({ label: 'Timezone', description: 'e.g. UTC or America/New_York.', required: false }),
    agenda: longText({ label: 'Agenda', required: false }),
    password: shortText({ label: 'Passcode', required: false }),
  },
  async run({ auth, props, http }): Promise<ZoomMeeting> {
    const body: Record<string, JsonValue> = { topic: props.topic, type: props.type ?? 2 };
    if (props.start_time !== undefined) body.start_time = props.start_time;
    if (props.duration !== undefined) body.duration = props.duration;
    if (props.timezone !== undefined) body.timezone = props.timezone;
    if (props.agenda !== undefined) body.agenda = props.agenda;
    if (props.password !== undefined) body.password = props.password;
    const userId = props.userId && props.userId.trim() !== '' ? props.userId : 'me';
    const res = await http.post<ZoomMeeting>(
      `${ZOOM_API_BASE}/users/${encodeURIComponent(userId)}/meetings`,
      {
        auth,
        body,
      },
    );
    return res.data;
  },
});

/** List a host's meetings, following Zoom's `next_page_token` cursor up to `limit`. */
export const listMeetings = defineAction({
  type: LIST_MEETINGS_TYPE,
  name: 'List Zoom meetings',
  description: 'List a host’s Zoom meetings.',
  auth: zoomAuth,
  props: {
    userId: userIdProp(),
    type: dropdown<string, false>({
      label: 'Filter',
      required: false,
      defaultValue: 'scheduled',
      options: [
        { label: 'Scheduled', value: 'scheduled' },
        { label: 'Live', value: 'live' },
        { label: 'Upcoming', value: 'upcoming' },
      ],
    }),
    limit: number({ label: 'Max results', required: false, defaultValue: 30 }),
  },
  async run({ auth, props, http }): Promise<{ meetings: ZoomMeetingListEntry[]; count: number }> {
    const userId = props.userId && props.userId.trim() !== '' ? props.userId : 'me';
    const meetings = await paginate<ZoomMeetingListEntry>({
      http,
      auth,
      url: `${ZOOM_API_BASE}/users/${encodeURIComponent(userId)}/meetings`,
      query: { type: props.type ?? 'scheduled', page_size: 30 },
      extractItems: (res) => (res.data as { meetings?: ZoomMeetingListEntry[] }).meetings ?? [],
      nextPage: cursorInBody({ cursorPath: ['next_page_token'], cursorParam: 'next_page_token' }),
      maxItems: props.limit ?? 30,
    });
    return { meetings, count: meetings.length };
  },
});

/** Retrieve a meeting by id. Read-only. */
export const getMeeting = defineAction({
  type: GET_MEETING_TYPE,
  name: 'Find Zoom meeting',
  description: 'Retrieve a Zoom meeting by id.',
  auth: zoomAuth,
  props: {
    meetingId: shortText<true>({ label: 'Meeting id', required: true }),
  },
  async run({ auth, props, http }): Promise<ZoomMeeting> {
    const res = await http.get<ZoomMeeting>(
      `${ZOOM_API_BASE}/meetings/${encodeURIComponent(props.meetingId)}`,
      {
        auth,
      },
    );
    return res.data;
  },
});

/** The synthesised result of the 204-No-Content update/delete. */
export interface ZoomMeetingMutationResult {
  meetingId: string;
}

/** Update a meeting (PATCH, supplied fields only); Zoom returns 204 No Content, so the result is synthesised. */
export const updateMeeting = defineAction({
  type: UPDATE_MEETING_TYPE,
  name: 'Update Zoom meeting',
  description: 'Update fields of a Zoom meeting.',
  auth: zoomAuth,
  props: {
    meetingId: shortText<true>({ label: 'Meeting id', required: true }),
    topic: shortText({ label: 'Topic', required: false }),
    start_time: dateTime({ label: 'Start time', description: 'New start time (RFC3339).', required: false }),
    duration: number({ label: 'Duration (minutes)', required: false }),
    timezone: shortText({ label: 'Timezone', required: false }),
    agenda: longText({ label: 'Agenda', required: false }),
  },
  async run({ auth, props, http }): Promise<ZoomMeetingMutationResult & { updated: true }> {
    const body: Record<string, JsonValue> = {};
    if (props.topic !== undefined) body.topic = props.topic;
    if (props.start_time !== undefined) body.start_time = props.start_time;
    if (props.duration !== undefined) body.duration = props.duration;
    if (props.timezone !== undefined) body.timezone = props.timezone;
    if (props.agenda !== undefined) body.agenda = props.agenda;
    await http.patch(`${ZOOM_API_BASE}/meetings/${encodeURIComponent(props.meetingId)}`, { auth, body });
    return { updated: true, meetingId: props.meetingId };
  },
});

/** Delete a meeting by id. Zoom returns 204 No Content → synthesised confirmation. */
export const deleteMeeting = defineAction({
  type: DELETE_MEETING_TYPE,
  name: 'Delete Zoom meeting',
  description: 'Delete a Zoom meeting by id.',
  auth: zoomAuth,
  props: {
    meetingId: shortText<true>({ label: 'Meeting id', required: true }),
  },
  async run({ auth, props, http }): Promise<ZoomMeetingMutationResult & { deleted: true }> {
    await http.delete(`${ZOOM_API_BASE}/meetings/${encodeURIComponent(props.meetingId)}`, { auth });
    return { deleted: true, meetingId: props.meetingId };
  },
});
