import { HttpClient } from '../../core/http/client';
import type { NormalizedRequest, NormalizedResponse } from '../../core/http/types';
import { FakeTransport, stubAuth } from '../../testing/fakes';
import { zoomAuth } from './common';
import { createMeeting, deleteMeeting, getMeeting, listMeetings, updateMeeting } from './meetings';

/**
 * Golden offline tests for the Zoom actions. A {@link FakeTransport} replays
 * canned API v2 responses and records requests, asserting the create body, the
 * "me" host fallback, `next_page_token` pagination, the 204 update/delete
 * synthesis, and the live host picker without a connection.
 */
function fake(handler: (req: NormalizedRequest, i: number) => NormalizedResponse) {
  const transport = new FakeTransport(handler);
  return { auth: stubAuth(transport, 'oauth2'), http: new HttpClient(), transport };
}

describe('zoom auth scopes', () => {
  it('declares the 2024 granular scope names (BYO own-client OAuth requires them)', () => {
    expect(zoomAuth.scopes).toEqual([
      'meeting:read:meeting',
      'meeting:write:meeting',
      'user:read:user',
      'user:read:list_users:admin',
    ]);
  });
});

describe('zoom.zoom_create_meeting', () => {
  it('POSTs to the host’s meetings and defaults the host to "me" and type to scheduled', async () => {
    const { auth, http, transport } = fake(() => ({
      status: 201,
      headers: {},
      data: { id: 812, topic: 'Standup', type: 2, join_url: 'https://zoom.us/j/812' },
    }));
    const out = await createMeeting.execute({
      auth,
      http,
      props: { topic: 'Standup', start_time: '2026-07-10T10:00:00Z', duration: 30 },
    });
    expect(out.id).toBe(812);
    const req = transport.requests[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('https://api.zoom.us/v2/users/me/meetings');
    expect(req.body).toEqual({ topic: 'Standup', type: 2, start_time: '2026-07-10T10:00:00Z', duration: 30 });
  });

  it('targets an explicit host id when supplied', async () => {
    const { auth, http, transport } = fake(() => ({
      status: 201,
      headers: {},
      data: { id: 9, topic: 'x', type: 2 },
    }));
    await createMeeting.execute({ auth, http, props: { topic: 'x', userId: 'user@acme.com' } });
    expect(transport.requests[0]!.url).toBe('https://api.zoom.us/v2/users/user%40acme.com/meetings');
  });
});

describe('zoom.list_meetings', () => {
  it('follows next_page_token and defaults the filter to scheduled', async () => {
    const { auth, http, transport } = fake((_req, i) =>
      i === 0
        ? {
            status: 200,
            headers: {},
            data: { meetings: [{ id: 1, topic: 'a', type: 2 }], next_page_token: 'NP' },
          }
        : {
            status: 200,
            headers: {},
            data: { meetings: [{ id: 2, topic: 'b', type: 2 }], next_page_token: '' },
          },
    );
    const out = await listMeetings.execute({ auth, http, props: { limit: 100 } });
    expect(out.count).toBe(2);
    expect(transport.requests[0]!.url).toContain('type=scheduled');
    expect(transport.requests[1]!.url).toContain('next_page_token=NP');
  });
});

describe('zoom.zoom_find_meeting', () => {
  it('GETs a meeting by id', async () => {
    const { auth, http, transport } = fake(() => ({
      status: 200,
      headers: {},
      data: { id: 555, topic: 'Review', type: 2 },
    }));
    const out = await getMeeting.execute({ auth, http, props: { meetingId: '555' } });
    expect(out.topic).toBe('Review');
    expect(transport.requests[0]!.url).toBe('https://api.zoom.us/v2/meetings/555');
  });
});

describe('zoom.zoom_update_meeting', () => {
  it('PATCHes only supplied fields and synthesises a confirmation from the 204', async () => {
    const { auth, http, transport } = fake(() => ({ status: 204, headers: {}, data: undefined }));
    const out = await updateMeeting.execute({ auth, http, props: { meetingId: '555', topic: 'Renamed' } });
    expect(out).toEqual({ updated: true, meetingId: '555' });
    const req = transport.requests[0]!;
    expect(req.method).toBe('PATCH');
    expect(req.body).toEqual({ topic: 'Renamed' });
  });
});

describe('zoom.delete_meeting', () => {
  it('DELETEs and synthesises a confirmation from the 204', async () => {
    const { auth, http, transport } = fake(() => ({ status: 204, headers: {}, data: undefined }));
    const out = await deleteMeeting.execute({ auth, http, props: { meetingId: '555' } });
    expect(out).toEqual({ deleted: true, meetingId: '555' });
    expect(transport.requests[0]!.method).toBe('DELETE');
  });
});

describe('zoom host picker', () => {
  it('lists users and maps name + email → id', async () => {
    const { auth, http } = fake(() => ({
      status: 200,
      headers: {},
      data: { users: [{ id: 'u1', email: 'ada@acme.com', first_name: 'Ada', last_name: 'Lovelace' }] },
    }));
    const picker = await createMeeting.loadOptions('userId', { auth, http });
    expect(picker.disabled).toBe(false);
    expect(picker.options[0]).toEqual({ label: 'Ada Lovelace (ada@acme.com)', value: 'u1' });
  });
});
