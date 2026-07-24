import { HttpClient } from '../../core/http/client';
import type { NormalizedRequest, NormalizedResponse } from '../../core/http/types';
import { FakeTransport, stubAuth } from '../../testing/fakes';
import { search } from './other';
import { createTicket, getTicket, listTickets, updateTicket } from './tickets';

/**
 * Golden offline tests for the Zendesk actions. A {@link FakeTransport} replays
 * canned Support-API envelopes and records requests, asserting the subdomain-scoped
 * host, the `{ ticket }` write body, and `next_page` pagination without a connection.
 */
const SUB = 'acme';
const BASE = `https://${SUB}.zendesk.com/api/v2`;

function fake(handler: (req: NormalizedRequest, i: number) => NormalizedResponse) {
  const transport = new FakeTransport(handler);
  return { auth: stubAuth(transport, 'basic'), http: new HttpClient(), transport };
}

describe('zendesk.create_ticket', () => {
  it('wraps subject + comment (+ requester/tags) in a ticket body', async () => {
    const { auth, http, transport } = fake(() => ({
      status: 201,
      headers: {},
      data: { ticket: { id: 1, subject: 'Help', status: 'new' } },
    }));
    const out = await createTicket.execute({
      auth,
      http,
      props: {
        subdomain: SUB,
        subject: 'Help',
        comment: 'It broke',
        requesterEmail: 'a@b.com',
        tags: 'bug, urgent',
      },
    });
    expect(out.id).toBe(1);
    const req = transport.requests[0]!;
    expect(req.url).toBe(`${BASE}/tickets.json`);
    expect(req.body).toEqual({
      ticket: {
        subject: 'Help',
        comment: { body: 'It broke' },
        requester: { email: 'a@b.com' },
        tags: ['bug', 'urgent'],
      },
    });
  });
});

describe('zendesk.get_ticket', () => {
  it('reads the ticket by id and unwraps it', async () => {
    const { auth, http, transport } = fake(() => ({
      status: 200,
      headers: {},
      data: { ticket: { id: 42, subject: 'x', status: 'open' } },
    }));
    const out = await getTicket.execute({ auth, http, props: { subdomain: SUB, ticketId: 42 } });
    expect(out.status).toBe('open');
    expect(transport.requests[0]!.url).toBe(`${BASE}/tickets/42.json`);
  });
});

describe('zendesk.update_ticket', () => {
  it('PUTs only supplied fields and shapes an internal comment', async () => {
    const { auth, http, transport } = fake(() => ({
      status: 200,
      headers: {},
      data: { ticket: { id: 42, subject: 'x', status: 'solved' } },
    }));
    await updateTicket.execute({
      auth,
      http,
      props: { subdomain: SUB, ticketId: 42, status: 'solved', comment: 'done', publicComment: 'internal' },
    });
    const req = transport.requests[0]!;
    expect(req.method).toBe('PUT');
    expect(req.body).toEqual({ ticket: { status: 'solved', comment: { body: 'done', public: false } } });
  });
});

describe('zendesk.list_tickets', () => {
  it('follows next_page across pages', async () => {
    const { auth, http, transport } = fake((_req, i) =>
      i === 0
        ? {
            status: 200,
            headers: {},
            data: {
              tickets: [{ id: 1, subject: 'a', status: 'open' }],
              next_page: `${BASE}/tickets.json?page=2`,
            },
          }
        : {
            status: 200,
            headers: {},
            data: { tickets: [{ id: 2, subject: 'b', status: 'open' }], next_page: null },
          },
    );
    const out = await listTickets.execute({ auth, http, props: { subdomain: SUB } });
    expect(out.count).toBe(2);
    expect(transport.requests[1]!.url).toBe(`${BASE}/tickets.json?page=2`);
  });
});

describe('zendesk.search', () => {
  it('passes the query to /search.json', async () => {
    const { auth, http, transport } = fake(() => ({
      status: 200,
      headers: {},
      data: { results: [], count: 0 },
    }));
    await search.execute({ auth, http, props: { subdomain: SUB, query: 'type:ticket status:open' } });
    const url = transport.requests[0]!.url;
    expect(url).toContain(`${BASE}/search.json`);
    expect(url).toContain('query=type%3Aticket');
  });
});
