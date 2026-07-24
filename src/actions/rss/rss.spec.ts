import type { NormalizedResponse } from '../../core/http/types';
import { FakeTransport, stubAuth } from '../../testing/fakes';
import { MemoryStore } from '../../testing/memory-store';
import { parseFeed } from './feed';
import { newItem } from './new-item.polling';

const RSS_SAMPLE = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <title>Example</title>
  <item>
    <title><![CDATA[First & foremost]]></title>
    <link>https://ex.com/1</link>
    <guid>guid-1</guid>
    <pubDate>Mon, 06 Jul 2026 10:00:00 GMT</pubDate>
    <description>Hello &amp; welcome</description>
  </item>
  <item>
    <title>Second</title>
    <link>https://ex.com/2</link>
    <guid>guid-2</guid>
  </item>
</channel></rss>`;

const ATOM_SAMPLE = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>Atom one</title>
    <link href="https://ex.com/a1" rel="alternate"/>
    <id>atom-1</id>
    <updated>2026-07-06T10:00:00Z</updated>
    <summary>Summary one</summary>
  </entry>
</feed>`;

describe('rss feed parser', () => {
  it('parses RSS items, decoding CDATA and entities', () => {
    const items = parseFeed(RSS_SAMPLE);
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({
      title: 'First & foremost',
      link: 'https://ex.com/1',
      id: 'guid-1',
      pubDate: 'Mon, 06 Jul 2026 10:00:00 GMT',
      summary: 'Hello & welcome',
    });
    expect(items[1]!.id).toBe('guid-2');
  });

  it('parses Atom entries (href link + id + summary)', () => {
    const items = parseFeed(ATOM_SAMPLE);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ title: 'Atom one', link: 'https://ex.com/a1', id: 'atom-1' });
  });
});

describe('rss.new_item polling trigger', () => {
  const feedResponse = (xml: string): NormalizedResponse => ({
    status: 200,
    headers: { 'content-type': 'application/rss+xml' },
    data: xml,
  });

  it('emits new items then dedupes by guid', async () => {
    const store = new MemoryStore();
    const first = await newItem.runPoll({
      auth: stubAuth(new FakeTransport(() => feedResponse(RSS_SAMPLE))),
      props: { url: 'https://ex.com/feed.xml' },
      store,
    });
    expect(first.events.map((i) => i.id)).toEqual(['guid-1', 'guid-2']);

    const second = await newItem.runPoll({
      auth: stubAuth(new FakeTransport(() => feedResponse(RSS_SAMPLE))),
      props: { url: 'https://ex.com/feed.xml' },
      store,
    });
    expect(second.events).toEqual([]);

    const withNew = RSS_SAMPLE.replace(
      '</channel>',
      '<item><title>Third</title><link>https://ex.com/3</link><guid>guid-3</guid></item></channel>',
    );
    const third = await newItem.runPoll({
      auth: stubAuth(new FakeTransport(() => feedResponse(withNew))),
      props: { url: 'https://ex.com/feed.xml' },
      store,
    });
    expect(third.events.map((i) => i.id)).toEqual(['guid-3']);
  });

  it('blocks polling a private/internal feed URL before any fetch (SSRF guard)', async () => {
    const store = new MemoryStore();
    const transport = new FakeTransport(() => feedResponse(RSS_SAMPLE));
    await expect(
      newItem.runPoll({ auth: stubAuth(transport), props: { url: 'http://192.168.1.10/feed.xml' }, store }),
    ).rejects.toMatchObject({ code: 'ssrf_blocked' });
    expect(transport.requests).toHaveLength(0); // guard fired before any fetch
  });
});
