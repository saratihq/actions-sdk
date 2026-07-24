import type { NormalizedResponse } from '../../core/http/types';
import { FakeTransport, stubAuth } from '../../testing/fakes';
import { MemoryStore } from '../../testing/memory-store';
import { newContact } from './new-contact.polling';

/**
 * A CRM v3 contacts-search response — shape from HubSpot's public search docs
 * (`results[]` with id/properties/createdAt, `paging.next.after`).
 * https://developers.hubspot.com/docs/guides/api/crm/search
 */
function searchResponse(results: unknown[], nextAfter?: string): NormalizedResponse {
  return {
    status: 200,
    headers: {},
    data: {
      total: results.length,
      results,
      paging: nextAfter !== undefined ? { next: { after: nextAfter } } : {},
    },
  };
}

const ADA = {
  id: '501',
  properties: {
    email: 'ada@example.com',
    firstname: 'Ada',
    lastname: 'Lovelace',
    phone: '+15551230001',
    company: 'Analytical Engines',
    createdate: '2024-01-17T19:55:04.281Z',
  },
  createdAt: '2024-01-17T19:55:04.281Z',
  updatedAt: '2024-01-17T19:55:04.281Z',
  archived: false,
};
const ALAN = {
  id: '502',
  properties: {
    email: 'alan@example.com',
    firstname: 'Alan',
    lastname: 'Turing',
    phone: null,
    company: null,
    createdate: '2024-01-17T20:00:00.000Z',
  },
  createdAt: '2024-01-17T20:00:00.000Z',
  updatedAt: '2024-01-17T20:00:00.000Z',
  archived: false,
};

/** Overlap re-scan window (60s) subtracted from the watermark before it becomes `createdate GT`. */
const OVERLAP_MS = 60_000;
/** A cursor watermark (epoch-millis) as the trigger persists it. */
const CURSOR_MS = Date.parse('2024-01-17T21:00:00.000Z');

/**
 * A store already past its first poll: `lastPolledAt` present (so `poll` runs its
 * normal bounded read instead of self-baselining) and a `cursor` epoch-millis
 * watermark set. Mirrors the runtime state after activation + one baseline poll.
 */
async function primedStore(): Promise<MemoryStore> {
  const store = new MemoryStore();
  await store.set('lastPolledAt', '2026-07-20T00:00:00.000Z');
  await store.set('cursor', CURSOR_MS);
  return store;
}

describe('hubspot.new_contact — polling', () => {
  it('baselines on the first poll: emits nothing and reads no history', async () => {
    const transport = new FakeTransport(() => searchResponse([ADA, ALAN]));
    const store = new MemoryStore();

    const { events } = await newContact.runPoll({ auth: stubAuth(transport), props: {}, store });

    // Empty watermark → pure baseline: zero events and NOT a single API call, so
    // activating never backfills the portal's existing contacts.
    expect(events).toEqual([]);
    expect(transport.requests).toHaveLength(0);
    // The cursor is persisted so the next poll reads forward from "now".
    expect(typeof store.snapshot().cursor).toBe('number');
    expect(typeof store.snapshot().lastPolledAt).toBe('string');
  });

  it('queries createdate GT (watermark − 60s overlap) sorted ASCENDING against the CRM v3 search endpoint', async () => {
    const transport = new FakeTransport(() => searchResponse([ADA, ALAN]));
    await newContact.runPoll({ auth: stubAuth(transport), props: {}, store: await primedStore() });

    const sent = transport.requests[0];
    expect(sent?.method).toBe('POST');
    expect(sent?.url).toBe('https://api.hubapi.com/crm/v3/objects/contacts/search');
    const body = sent?.body as {
      filterGroups: Array<{ filters: Array<{ propertyName: string; operator: string; value: string }> }>;
      sorts: Array<{ propertyName: string; direction: string }>;
      limit: number;
    };
    const filter = body.filterGroups[0]?.filters[0];
    expect(filter?.propertyName).toBe('createdate');
    expect(filter?.operator).toBe('GT');
    // Epoch-millis STRING, re-scanning a full 60s behind the watermark so a
    // late-indexed / out-of-order contact is never permanently dropped.
    expect(filter?.value).toBe(String(CURSOR_MS - OVERLAP_MS));
    expect(typeof filter?.value).toBe('string');
    // Guard the fix: the old 2s overlap would have dropped index-lagged contacts.
    expect(filter?.value).not.toBe(String(CURSOR_MS - 2_000));
    expect(body.sorts[0]).toEqual({ propertyName: 'createdate', direction: 'ASCENDING' });
    expect(body.limit).toBe(100);
  });

  it('transforms a real search payload into normalised contact events', async () => {
    const transport = new FakeTransport(() => searchResponse([ADA, ALAN]));
    const result = await newContact.runPoll({
      auth: stubAuth(transport),
      props: {},
      store: await primedStore(),
    });

    expect(result.events).toEqual([
      {
        id: '501',
        createdAt: '2024-01-17T19:55:04.281Z',
        email: 'ada@example.com',
        firstname: 'Ada',
        lastname: 'Lovelace',
        properties: {
          email: 'ada@example.com',
          firstname: 'Ada',
          lastname: 'Lovelace',
          phone: '+15551230001',
          company: 'Analytical Engines',
          createdate: '2024-01-17T19:55:04.281Z',
        },
      },
      {
        id: '502',
        createdAt: '2024-01-17T20:00:00.000Z',
        email: 'alan@example.com',
        firstname: 'Alan',
        lastname: 'Turing',
        properties: {
          email: 'alan@example.com',
          firstname: 'Alan',
          lastname: 'Turing',
          phone: null,
          company: null,
          createdate: '2024-01-17T20:00:00.000Z',
        },
      },
    ]);
  });

  it('drains pages via paging.next.after up to the page cap', async () => {
    // First page carries a cursor; second page has none → drain stops after two calls.
    const transport = new FakeTransport((_req, i) =>
      i === 0 ? searchResponse([ADA], 'page2') : searchResponse([ALAN]),
    );
    const result = await newContact.runPoll({
      auth: stubAuth(transport),
      props: {},
      store: await primedStore(),
    });

    expect(transport.requests).toHaveLength(2);
    // The second request carries the `after` cursor the first page returned.
    expect((transport.requests[1]?.body as { after?: string }).after).toBe('page2');
    expect(result.events.map((e) => e.id)).toEqual(['501', '502']);
  });

  it('dedupes by contact id across polls (id-dedupe absorbs the overlap re-scan)', async () => {
    const store = await primedStore();

    const first = await newContact.runPoll({
      auth: stubAuth(new FakeTransport(() => searchResponse([ADA, ALAN]))),
      props: {},
      store,
    });
    expect(first.events.map((e) => e.id)).toEqual(['501', '502']);

    // Same contacts re-surface inside the wider 60s overlap → nothing new fires.
    const second = await newContact.runPoll({
      auth: stubAuth(new FakeTransport(() => searchResponse([ADA, ALAN]))),
      props: {},
      store,
    });
    expect(second.events).toEqual([]);

    // A genuinely new contact appears → only it fires.
    const grace = {
      ...ADA,
      id: '503',
      properties: { ...ADA.properties, email: 'grace@example.com', createdate: '2024-01-17T22:00:00.000Z' },
      createdAt: '2024-01-17T22:00:00.000Z',
    };
    const third = await newContact.runPoll({
      auth: stubAuth(new FakeTransport(() => searchResponse([ADA, ALAN, grace]))),
      props: {},
      store,
    });
    expect(third.events.map((e) => e.id)).toEqual(['503']);
  });
});
