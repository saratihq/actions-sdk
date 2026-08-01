import { HttpClient } from '../../core/http/client';
import type { NormalizedRequest, NormalizedResponse } from '../../core/http/types';
import { FakeTransport, stubAuth } from '../../testing/fakes';
import {
  cancelScheduledEvent,
  getCurrentUserAction,
  getScheduledEvent,
  listEventTypes,
  listScheduledEvents,
} from './events';

/** Offline tests for the Calendly actions, driven by a {@link FakeTransport}. */
const USER_URI = 'https://api.calendly.com/users/U1';

function fake(handler: (req: NormalizedRequest, i: number) => NormalizedResponse) {
  const transport = new FakeTransport(handler);
  return { auth: stubAuth(transport, 'apiKey'), http: new HttpClient(), transport };
}

function meResponse(): NormalizedResponse {
  return {
    status: 200,
    headers: {},
    data: {
      resource: {
        uri: USER_URI,
        name: 'Ada',
        email: 'ada@x.com',
        scheduling_url: 'u',
        current_organization: 'o',
      },
    },
  };
}

describe('calendly.get_current_user', () => {
  it('returns the /users/me resource', async () => {
    const { auth, http, transport } = fake(() => meResponse());
    const out = await getCurrentUserAction.execute({ auth, http, props: {} });
    expect(out.email).toBe('ada@x.com');
    expect(transport.requests[0]!.url).toBe('https://api.calendly.com/users/me');
  });
});

describe('calendly.list_event_types', () => {
  it('resolves the user then scopes the event-types read to it', async () => {
    const { auth, http, transport } = fake((_req, i) =>
      i === 0
        ? meResponse()
        : {
            status: 200,
            headers: {},
            data: {
              collection: [{ uri: 'et1', name: 'Intro', active: true, duration: 30, scheduling_url: 'u' }],
              pagination: { next_page: null },
            },
          },
    );
    const out = await listEventTypes.execute({ auth, http, props: { activeOnly: 'true' } });
    expect(out.count).toBe(1);
    const url = transport.requests[1]!.url;
    expect(url).toContain('user=https%3A%2F%2Fapi.calendly.com%2Fusers%2FU1');
    expect(url).toContain('active=true');
  });
});

describe('calendly.list_scheduled_events', () => {
  it('follows next_page across pages', async () => {
    const { auth, http, transport } = fake((_req, i) => {
      if (i === 0) return meResponse();
      if (i === 1)
        return {
          status: 200,
          headers: {},
          data: {
            collection: [{ uri: 'e1', name: 'A', status: 'active', start_time: 's', end_time: 'e' }],
            pagination: { next_page: 'https://api.calendly.com/scheduled_events?page=2' },
          },
        };
      return {
        status: 200,
        headers: {},
        data: {
          collection: [{ uri: 'e2', name: 'B', status: 'active', start_time: 's', end_time: 'e' }],
          pagination: { next_page: null },
        },
      };
    });
    const out = await listScheduledEvents.execute({ auth, http, props: {} });
    expect(out.count).toBe(2);
    expect(transport.requests[2]!.url).toBe('https://api.calendly.com/scheduled_events?page=2');
  });
});

describe('calendly.get_scheduled_event + event picker', () => {
  it('gets by uuid and the picker maps recent events', async () => {
    const { auth, http, transport } = fake((_req, i) =>
      i === 0
        ? {
            status: 200,
            headers: {},
            data: { resource: { uri: 'e1', name: 'A', status: 'active', start_time: 's', end_time: 'e' } },
          }
        : meResponse(),
    );
    const out = await getScheduledEvent.execute({ auth, http, props: { eventUuid: 'EV1' } });
    expect(out.name).toBe('A');
    expect(transport.requests[0]!.url).toBe('https://api.calendly.com/scheduled_events/EV1');

    // Picker: /users/me then /scheduled_events, mapped to uuid values.
    const { auth: a2, http: h2 } = fake((_req, i) =>
      i === 0
        ? meResponse()
        : {
            status: 200,
            headers: {},
            data: {
              collection: [
                {
                  uri: `${USER_URI.replace('users', 'scheduled_events')}/EVX`,
                  name: 'A',
                  status: 'active',
                  start_time: 's',
                  end_time: 'e',
                },
              ],
              pagination: { next_page: null },
            },
          },
    );
    const picker = await getScheduledEvent.loadOptions('eventUuid', { auth: a2, http: h2 });
    expect(picker.options[0]?.value).toBe('EVX');
  });
});

describe('calendly.cancel_scheduled_event', () => {
  it('POSTs the cancellation with a reason body', async () => {
    const { auth, http, transport } = fake(() => ({
      status: 201,
      headers: {},
      data: { resource: { uri: 'e1', name: 'A', status: 'canceled', start_time: 's', end_time: 'e' } },
    }));
    await cancelScheduledEvent.execute({
      auth,
      http,
      props: { eventUuid: 'EV1', reason: 'no longer needed' },
    });
    const req = transport.requests[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('https://api.calendly.com/scheduled_events/EV1/cancellation');
    expect(req.body).toEqual({ reason: 'no longer needed' });
  });
});
