import { HttpClient } from '../../core/http/client';
import type { NormalizedRequest, NormalizedResponse } from '../../core/http/types';
import { FakeTransport, stubAuth } from '../../testing/fakes';
import { listCalendars } from './calendars';
import { defaultEnd, toAttendees } from './common';
import { createEvent, deleteEvent, getEvent, listEvents, updateEvent } from './events';

/**
 * Golden offline tests for the Google Calendar actions. A {@link FakeTransport}
 * replays canned API v3 responses and records requests, asserting the event body
 * shape, the +30-min default end, PATCH partial-update semantics, the delete 204
 * synthesis, `nextPageToken` pagination, and the live calendar picker without a
 * connection.
 */
function fake(handler: (req: NormalizedRequest, i: number) => NormalizedResponse) {
  const transport = new FakeTransport(handler);
  return { auth: stubAuth(transport, 'oauth2'), http: new HttpClient(), transport };
}

describe('calendar helpers', () => {
  it('defaultEnd adds 30 minutes to the start', () => {
    expect(defaultEnd('2026-07-10T10:00:00.000Z')).toBe('2026-07-10T10:30:00.000Z');
  });

  it('toAttendees accepts email strings and { email } objects, rejects the rest', () => {
    expect(toAttendees(['a@b.com', { email: 'c@d.com' }])).toEqual([
      { email: 'a@b.com' },
      { email: 'c@d.com' },
    ]);
    expect(() => toAttendees('a@b.com')).toThrow(/must be an array/);
    expect(() => toAttendees([{ name: 'no email' }])).toThrow(/email/);
  });
});

describe('calendar.create_google_calendar_event', () => {
  it('POSTs the event with start/end and defaults end to start + 30 min', async () => {
    const { auth, http, transport } = fake(() => ({
      status: 200,
      headers: {},
      data: { id: 'e1', summary: 'Standup' },
    }));
    const out = await createEvent.execute({
      auth,
      http,
      props: {
        calendarId: 'primary',
        title: 'Standup',
        start: '2026-07-10T10:00:00.000Z',
        attendees: ['a@b.com'],
      },
    });
    expect(out.id).toBe('e1');
    const req = transport.requests[0]!;
    expect(req.method).toBe('POST');
    // sendUpdates defaults to 'all' so attendees are actually emailed the invite.
    expect(req.url).toBe('https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=all');
    const body = req.body as {
      summary: string;
      start: { dateTime: string };
      end: { dateTime: string };
      attendees: Array<{ email: string }>;
    };
    expect(body.summary).toBe('Standup');
    expect(body.start.dateTime).toBe('2026-07-10T10:00:00.000Z');
    expect(body.end.dateTime).toBe('2026-07-10T10:30:00.000Z');
    expect(body.attendees).toEqual([{ email: 'a@b.com' }]);
  });

  it('honours an explicit end and encodes a non-primary calendar id', async () => {
    const { auth, http, transport } = fake(() => ({ status: 200, headers: {}, data: { id: 'e2' } }));
    await createEvent.execute({
      auth,
      http,
      props: {
        calendarId: 'team@group.calendar.google.com',
        title: 'Review',
        start: '2026-07-10T10:00:00.000Z',
        end: '2026-07-10T11:00:00.000Z',
      },
    });
    const req = transport.requests[0]!;
    expect(req.url).toContain('team%40group.calendar.google.com');
    expect((req.body as { end: { dateTime: string } }).end.dateTime).toBe('2026-07-10T11:00:00.000Z');
  });
});

describe('calendar.google_calendar_get_events', () => {
  it('passes the time window + singleEvents ordering and follows nextPageToken', async () => {
    const { auth, http, transport } = fake((_req, i) =>
      i === 0
        ? { status: 200, headers: {}, data: { items: [{ id: 'e1' }], nextPageToken: 'NP' } }
        : { status: 200, headers: {}, data: { items: [{ id: 'e2' }] } },
    );
    const out = await listEvents.execute({
      auth,
      http,
      props: { calendarId: 'primary', timeMin: '2026-07-01T00:00:00Z', limit: 100 },
    });
    expect(out.count).toBe(2);
    const first = transport.requests[0]!.url;
    expect(first).toContain('timeMin=2026-07-01T00%3A00%3A00Z');
    expect(first).toContain('singleEvents=true');
    expect(first).toContain('orderBy=startTime');
    expect(transport.requests[1]!.url).toContain('pageToken=NP');
  });
});

describe('calendar.google_calendar_get_event_by_id', () => {
  it('GETs a single event by id', async () => {
    const { auth, http, transport } = fake(() => ({
      status: 200,
      headers: {},
      data: { id: 'e9', summary: 'Lunch' },
    }));
    const out = await getEvent.execute({ auth, http, props: { calendarId: 'primary', eventId: 'e9' } });
    expect(out.summary).toBe('Lunch');
    expect(transport.requests[0]!.url).toBe(
      'https://www.googleapis.com/calendar/v3/calendars/primary/events/e9',
    );
  });
});

describe('calendar.update_event', () => {
  it('PATCHes only the supplied fields', async () => {
    const { auth, http, transport } = fake(() => ({ status: 200, headers: {}, data: { id: 'e1' } }));
    await updateEvent.execute({
      auth,
      http,
      props: { calendarId: 'primary', eventId: 'e1', title: 'Renamed' },
    });
    const req = transport.requests[0]!;
    expect(req.method).toBe('PATCH');
    expect(req.body).toEqual({ summary: 'Renamed' });
    // The update is emailed to attendees (default 'all').
    expect(req.url).toContain('sendUpdates=all');
  });

  it('passes an explicit sendUpdates choice through', async () => {
    const { auth, http, transport } = fake(() => ({ status: 200, headers: {}, data: { id: 'e1' } }));
    await updateEvent.execute({
      auth,
      http,
      props: { calendarId: 'primary', eventId: 'e1', title: 'Quiet', sendUpdates: 'none' },
    });
    expect(transport.requests[0]!.url).toContain('sendUpdates=none');
  });
});

describe('calendar.delete_event', () => {
  it('DELETEs and synthesises a confirmation from a 204', async () => {
    const { auth, http, transport } = fake(() => ({ status: 204, headers: {}, data: undefined }));
    const out = await deleteEvent.execute({ auth, http, props: { calendarId: 'primary', eventId: 'e1' } });
    expect(out).toEqual({ deleted: true, eventId: 'e1' });
    expect(transport.requests[0]!.method).toBe('DELETE');
    // The cancellation is emailed to attendees (default 'all').
    expect(transport.requests[0]!.url).toContain('sendUpdates=all');
  });
});

describe('calendar.list_calendars + calendar picker', () => {
  it('lists calendars and the picker maps summary→id, marking the primary', async () => {
    const { auth, http } = fake(() => ({
      status: 200,
      headers: {},
      data: {
        items: [
          { id: 'primary', summary: 'Me', primary: true },
          { id: 'team@group.calendar.google.com', summary: 'Team' },
        ],
      },
    }));
    const out = await listCalendars.execute({ auth, http, props: {} });
    expect(out.count).toBe(2);
    const picker = await createEvent.loadOptions('calendarId', { auth, http });
    expect(picker.disabled).toBe(false);
    expect(picker.options[0]).toEqual({ label: 'Me (primary)', value: 'primary' });
    expect(picker.options[1]).toEqual({ label: 'Team', value: 'team@group.calendar.google.com' });
  });
});
