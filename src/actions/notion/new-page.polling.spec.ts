import type { NormalizedResponse } from '../../core/http/types';
import { FakeTransport, stubAuth } from '../../testing/fakes';
import { MemoryStore } from '../../testing/memory-store';
import { type NotionPageEvent, newPage } from './new-page.polling';

const PROPS = { databaseId: '2f26ee68-df30-4251-aad4-8ddc420cba3d' };

/** A Notion database-query response, in the public `list` of `page` objects shape. */
const QUERY_RESPONSE: NormalizedResponse = {
  status: 200,
  headers: {},
  data: {
    object: 'list',
    results: [
      {
        object: 'page',
        id: '59833787-2cf9-4fdf-8782-e53db20768a5',
        created_time: '2026-07-20T19:05:00.000Z',
        last_edited_time: '2026-07-20T19:10:00.000Z',
        url: 'https://www.notion.so/Ada-Lovelace-59833787',
        properties: { Name: { id: 'title', type: 'title', title: [{ plain_text: 'Ada Lovelace' }] } },
      },
    ],
    next_cursor: null,
    has_more: false,
  },
};

describe('notion.new_page polling trigger', () => {
  it('baselines on first poll: no watermark, fires nothing, no network call', async () => {
    const transport = new FakeTransport(() => {
      throw new Error('first poll must not call the network');
    });
    const result = await newPage.runPoll({
      auth: stubAuth(transport),
      props: PROPS,
      store: new MemoryStore(),
    });
    expect(result.events).toEqual([]);
    expect(transport.requests).toHaveLength(0);
  });

  it('after the baseline, queries the database by created_time and normalises pages', async () => {
    const store = new MemoryStore();
    await newPage.runPoll({
      auth: stubAuth(
        new FakeTransport(() => ({ status: 200, headers: {}, data: { results: [], has_more: false } })),
      ),
      props: PROPS,
      store,
    });

    const transport = new FakeTransport(() => QUERY_RESPONSE);
    const result = await newPage.runPoll({ auth: stubAuth(transport), props: PROPS, store });

    expect(result.events).toEqual<NotionPageEvent[]>([
      {
        id: '59833787-2cf9-4fdf-8782-e53db20768a5',
        url: 'https://www.notion.so/Ada-Lovelace-59833787',
        createdTime: '2026-07-20T19:05:00.000Z',
        lastEditedTime: '2026-07-20T19:10:00.000Z',
        properties: { Name: { id: 'title', type: 'title', title: [{ plain_text: 'Ada Lovelace' }] } },
        databaseId: '2f26ee68-df30-4251-aad4-8ddc420cba3d',
      },
    ]);

    const sent = transport.requests[0];
    expect(sent?.method).toBe('POST');
    expect(sent?.url).toBe('https://api.notion.com/v1/databases/2f26ee68-df30-4251-aad4-8ddc420cba3d/query');
    const body = sent?.body as {
      filter: { timestamp: string; created_time: { after: string } };
      sorts: Array<{ timestamp: string; direction: string }>;
    };
    expect(body.filter).toEqual({ timestamp: 'created_time', created_time: { after: expect.any(String) } });
    expect(body.sorts).toEqual([{ timestamp: 'created_time', direction: 'descending' }]);
  });

  it('dedupes by page id — a page already emitted never fires twice', async () => {
    const store = new MemoryStore();
    await newPage.runPoll({
      auth: stubAuth(
        new FakeTransport(() => ({ status: 200, headers: {}, data: { results: [], has_more: false } })),
      ),
      props: PROPS,
      store,
    });
    const first = await newPage.runPoll({
      auth: stubAuth(new FakeTransport(() => QUERY_RESPONSE)),
      props: PROPS,
      store,
    });
    const second = await newPage.runPoll({
      auth: stubAuth(new FakeTransport(() => QUERY_RESPONSE)),
      props: PROPS,
      store,
    });
    expect(first.events.map((e) => e.id)).toEqual(['59833787-2cf9-4fdf-8782-e53db20768a5']);
    expect(second.events).toEqual([]);
  });
});
