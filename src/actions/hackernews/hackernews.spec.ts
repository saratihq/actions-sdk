import type { NormalizedRequest, NormalizedResponse } from '../../core/http/types';
import { FakeTransport, stubAuth } from '../../testing/fakes';
import { MemoryStore } from '../../testing/memory-store';
import { fetchTopStories, hackernewsActions, newStory } from './index';

/** A transport that answers the HN list + item endpoints from an id→item map. */
function hnTransport(ids: number[], items: Record<number, { title: string }>): FakeTransport {
  return new FakeTransport((req: NormalizedRequest): NormalizedResponse => {
    if (req.url.includes('stories.json')) return { status: 200, headers: {}, data: ids };
    const match = /\/item\/(\d+)\.json/.exec(req.url);
    if (match) {
      const id = Number(match[1]);
      return { status: 200, headers: {}, data: { id, ...items[id] } };
    }
    return { status: 404, headers: {}, data: null };
  });
}

describe('hackernews.fetch_top_stories', () => {
  it('fetches the first N stories in order', async () => {
    const transport = hnTransport([10, 20, 30], {
      10: { title: 'a' },
      20: { title: 'b' },
      30: { title: 'c' },
    });
    const out = await fetchTopStories.execute({ auth: stubAuth(transport), props: { limit: 2 } });
    expect(out.count).toBe(2);
    expect(out.stories.map((s) => s.id)).toEqual([10, 20]);
    expect(out.stories[0]!.title).toBe('a');
  });

  it('exposes one action, hackernews.* typed', () => {
    expect(hackernewsActions).toHaveLength(1);
    for (const action of hackernewsActions) expect(action.type.startsWith('hackernews.')).toBe(true);
  });
});

describe('hackernews.new_story polling trigger', () => {
  it('emits new stories, then dedupes', async () => {
    const store = new MemoryStore();
    const first = await newStory.runPoll({
      auth: stubAuth(hnTransport([1, 2], { 1: { title: 'one' }, 2: { title: 'two' } })),
      props: {},
      store,
    });
    expect(first.events.map((s) => s.id)).toEqual([1, 2]);

    const second = await newStory.runPoll({
      auth: stubAuth(hnTransport([1, 2], { 1: { title: 'one' }, 2: { title: 'two' } })),
      props: {},
      store,
    });
    expect(second.events).toEqual([]);

    const third = await newStory.runPoll({
      auth: stubAuth(
        hnTransport([3, 1, 2], { 1: { title: 'one' }, 2: { title: 'two' }, 3: { title: 'three' } }),
      ),
      props: {},
      store,
    });
    expect(third.events.map((s) => s.id)).toEqual([3]);
  });
});
