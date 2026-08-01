import type { NormalizedRequest, NormalizedResponse } from '../../core/http/types';
import { FakeTransport, stubAuth } from '../../testing/fakes';
import { MemoryStore } from '../../testing/memory-store';
import { newSubscriber } from './new-subscriber.polling';

const PROPS = { serverPrefix: 'us19', listId: 'abc123def' };

/** A `GET /lists/{id}/members` response; `total_items` is the filtered-query count the poll pages towards. */
function membersResponse(members: unknown[], totalItems = members.length): NormalizedResponse {
  return { status: 200, headers: {}, data: { members, total_items: totalItems } };
}

/** A synthetic subscribed member — unique id/email per index. */
function member(i: number): Record<string, unknown> {
  return {
    id: `id${String(i).padStart(30, '0')}`,
    email_address: `user${i}@example.com`,
    full_name: `User ${i}`,
    status: 'subscribed',
    timestamp_opt: `2026-07-20T00:${String(i % 60).padStart(2, '0')}:00+00:00`,
  };
}

/** A transport that serves `all` across `offset`/`count` pages, as the Marketing API does. */
function pagedTransport(all: Record<string, unknown>[]): FakeTransport {
  return new FakeTransport((req) => {
    const query = new URL(req.url).searchParams;
    const offset = Number(query.get('offset') ?? '0');
    const count = Number(query.get('count') ?? '100');
    return membersResponse(all.slice(offset, offset + count), all.length);
  });
}

const ADA = {
  id: 'f2a3c4d5e6b7a8f9c0d1e2f3a4b5c6d7',
  email_address: 'ada@example.com',
  full_name: 'Ada Lovelace',
  status: 'subscribed',
  timestamp_opt: '2026-07-18T18:17:02+00:00',
  merge_fields: { FNAME: 'Ada', LNAME: 'Lovelace' },
};
const GRACE = {
  id: '0123456789abcdef0123456789abcdef',
  email_address: 'grace@example.com',
  full_name: 'Grace Hopper',
  status: 'subscribed',
  timestamp_opt: '2026-07-18T19:00:00+00:00',
  merge_fields: { FNAME: 'Grace' },
};

/** A store already primed with a watermark, so `poll` runs its normal (bounded) read. */
async function primedStore(): Promise<MemoryStore> {
  const store = new MemoryStore();
  await store.set('lastPolledAt', '2026-07-20T00:00:00.000Z');
  return store;
}

describe('mailchimp.new_subscriber polling trigger', () => {
  it('baselines on the first poll: emits nothing and reads no history (INV-1)', async () => {
    const transport = new FakeTransport(() => membersResponse([GRACE, ADA]));
    const store = new MemoryStore();
    const { events } = await newSubscriber.runPoll({ auth: stubAuth(transport), props: PROPS, store });

    // No watermark → pure baseline: zero events and NOT a single API call, so
    // activating never backfills the existing audience.
    expect(events).toEqual([]);
    expect(transport.requests).toHaveLength(0);
    expect(typeof store.snapshot().lastPolledAt).toBe('string');
  });

  it('queries the datacenter-scoped members endpoint newest-opt-in first, bounded by opt-in time', async () => {
    const transport = new FakeTransport(() => membersResponse([ADA]));
    await newSubscriber.runPoll({ auth: stubAuth(transport), props: PROPS, store: await primedStore() });

    const sent = transport.requests[0] as NormalizedRequest;
    expect(sent.method).toBe('GET');
    const url = decodeURIComponent(sent.url);
    expect(url).toContain('https://us19.api.mailchimp.com/3.0/lists/abc123def/members?');
    expect(url).toContain('status=subscribed');
    expect(url).toContain('sort_field=timestamp_opt');
    expect(url).toContain('sort_dir=DESC');
    // Paged read: page size + first-page offset (best-effort DESC ordering only).
    expect(url).toContain('count=100');
    expect(url).toContain('offset=0');
    // Bounded server-side to opt-ins since the watermark (minus the 2-min overlap).
    expect(url).toContain('since_timestamp_opt=2026-07-19T23:58:00.000Z');
  });

  it('pages the whole window: a burst larger than one page is never truncated', async () => {
    // 250 opt-ins between polls — far past the old fixed 50-row head window.
    const all = Array.from({ length: 250 }, (_, i) => member(i));
    const transport = pagedTransport(all);
    const { events } = await newSubscriber.runPoll({
      auth: stubAuth(transport),
      props: PROPS,
      store: await primedStore(),
    });

    // Every member is emitted (none dropped), across three offset pages.
    expect(events).toHaveLength(250);
    expect(new Set(events.map((e) => e.id)).size).toBe(250);
    const offsets = transport.requests.map((r) => Number(new URL(r.url).searchParams.get('offset')));
    expect(offsets).toEqual([0, 100, 200]);
  });

  it('stops paging once the reported total is collected (no over-read)', async () => {
    const all = Array.from({ length: 100 }, (_, i) => member(i));
    const transport = pagedTransport(all);
    await newSubscriber.runPoll({ auth: stubAuth(transport), props: PROPS, store: await primedStore() });

    // total_items === 100 === one full page → the loop stops, no empty 2nd read.
    expect(transport.requests).toHaveLength(1);
  });

  it('normalises a member and dedupes by id across polls', async () => {
    const store = await primedStore();
    const first = await newSubscriber.runPoll({
      auth: stubAuth(new FakeTransport(() => membersResponse([GRACE, ADA]))),
      props: PROPS,
      store,
    });
    expect(first.events).toEqual([
      {
        id: GRACE.id,
        email: 'grace@example.com',
        fullName: 'Grace Hopper',
        status: 'subscribed',
        optedInAt: '2026-07-18T19:00:00+00:00',
        mergeFields: { FNAME: 'Grace' },
      },
      {
        id: ADA.id,
        email: 'ada@example.com',
        fullName: 'Ada Lovelace',
        status: 'subscribed',
        optedInAt: '2026-07-18T18:17:02+00:00',
        mergeFields: { FNAME: 'Ada', LNAME: 'Lovelace' },
      },
    ]);

    // Same members again → nothing new (SDK id-dedupe at the overlap boundary).
    const second = await newSubscriber.runPoll({
      auth: stubAuth(new FakeTransport(() => membersResponse([GRACE, ADA]))),
      props: PROPS,
      store,
    });
    expect(second.events).toEqual([]);

    // A brand-new subscriber appears at the top → only they fire.
    const eve = { ...ADA, id: 'aaaa1111bbbb2222cccc3333dddd4444', email_address: 'eve@example.com' };
    const third = await newSubscriber.runPoll({
      auth: stubAuth(new FakeTransport(() => membersResponse([eve, GRACE, ADA]))),
      props: PROPS,
      store,
    });
    expect(third.events.map((m) => m.email)).toEqual(['eve@example.com']);
  });
});
