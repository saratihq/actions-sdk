import type { NormalizedResponse } from '../../core/http/types';
import { FakeTransport, stubAuth } from '../../testing/fakes';
import { MemoryStore } from '../../testing/memory-store';
import { newTicket } from './new-ticket.polling';

const PROPS = { subdomain: 'acme' };

/** A freshly-created ticket (just after the trigger started watching). Built once so its timestamp is stable. */
const FRESH_CREATED_AT = new Date(Date.now() + 60_000).toISOString();
const FRESH_TICKET = {
  id: 35436,
  subject: 'Help, my printer is on fire!',
  status: 'open',
  priority: 'high',
  requester_id: 20978392,
  assignee_id: 235323,
  tags: ['enterprise', 'other_tag'],
  // Comfortably after "now" so it survives the created-at >= startedAt filter.
  created_at: FRESH_CREATED_AT,
  updated_at: FRESH_CREATED_AT,
};

/** An old ticket that merely got UPDATED — must NOT fire on a new-ticket trigger. */
const OLD_TICKET_UPDATED = {
  id: 1,
  subject: 'Ancient ticket, freshly updated',
  status: 'open',
  priority: 'normal',
  requester_id: 100,
  assignee_id: null,
  tags: [],
  created_at: '2020-01-01T00:00:00Z',
  updated_at: new Date(Date.now() + 60_000).toISOString(),
};

/** The incremental cursor-export envelope — shape from Zendesk's public docs. */
function incrementalResponse(): NormalizedResponse {
  return {
    status: 200,
    headers: {},
    data: {
      tickets: [FRESH_TICKET, OLD_TICKET_UPDATED],
      after_cursor: 'MTU3MjA0MzsyMTQ3NDgzNjQ3',
      after_url:
        'https://acme.zendesk.com/api/v2/incremental/tickets/cursor.json?cursor=MTU3MjA0MzsyMTQ3NDgzNjQ3',
      end_of_stream: true,
    },
  };
}

describe('zendesk.new_ticket — polling', () => {
  it('seeds from start_time against the subdomain-scoped incremental cursor endpoint', async () => {
    const transport = new FakeTransport(() => incrementalResponse());
    await newTicket.runPoll({ auth: stubAuth(transport), props: PROPS, store: new MemoryStore() });

    const sent = transport.requests[0];
    expect(sent?.method).toBe('GET');
    expect(sent?.url).toContain('https://acme.zendesk.com/api/v2/incremental/tickets/cursor.json');
    expect(sent?.url).toContain('start_time=');
  });

  it('emits only genuinely new tickets (updates to old tickets are filtered out)', async () => {
    const transport = new FakeTransport(() => incrementalResponse());
    const result = await newTicket.runPoll({
      auth: stubAuth(transport),
      props: PROPS,
      store: new MemoryStore(),
    });

    expect(result.events).toEqual([
      {
        id: 35436,
        subject: 'Help, my printer is on fire!',
        status: 'open',
        priority: 'high',
        requesterId: 20978392,
        assigneeId: 235323,
        tags: ['enterprise', 'other_tag'],
        createdAt: FRESH_CREATED_AT,
      },
    ]);
  });

  it('advances to the persisted cursor and dedupes by ticket id across polls', async () => {
    const transport = new FakeTransport(() => incrementalResponse());
    const auth = stubAuth(transport);
    const store = new MemoryStore();

    const first = await newTicket.runPoll({ auth, props: PROPS, store });
    expect(first.events.map((e) => e.id)).toEqual([35436]);
    expect(store.snapshot().cursor).toBe('MTU3MjA0MzsyMTQ3NDgzNjQ3');

    const second = await newTicket.runPoll({ auth, props: PROPS, store });
    expect(second.events).toEqual([]);
    // Second poll resumes from the cursor, not start_time.
    expect(transport.requests[1]?.url).toContain('cursor=MTU3MjA0MzsyMTQ3NDgzNjQ3');
  });
});
