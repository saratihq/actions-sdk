import type { NormalizedRequest, NormalizedResponse } from '../../core/http/types';
import { FakeTransport, stubAuth } from '../../testing/fakes';
import { MemoryStore } from '../../testing/memory-store';
import { type DropboxFileEvent, newFile } from './new-file.polling';

const PROPS = { path: '/Homework', recursive: true };

/** A real Dropbox `get_latest_cursor` response (shape from the HTTP docs). */
const LATEST_CURSOR: NormalizedResponse = {
  status: 200,
  headers: {},
  data: { cursor: 'AAF...BASELINE' },
};

/** A real `list_folder/continue` response: `.tag`-discriminated entries plus the advanced cursor. */
const CHANGES: NormalizedResponse = {
  status: 200,
  headers: {},
  data: {
    entries: [
      {
        '.tag': 'file',
        name: 'Prime_Numbers.txt',
        id: 'id:a4ayc_80_OEAAAAAAAAAYa',
        path_lower: '/homework/math/prime_numbers.txt',
        path_display: '/Homework/math/Prime_Numbers.txt',
        size: 7212,
        server_modified: '2026-07-20T15:50:38Z',
        rev: '015c7f4a2b',
        content_hash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      },
      { '.tag': 'folder', name: 'math', id: 'id:folder', path_lower: '/homework/math' },
    ],
    cursor: 'AAF...ADVANCED',
    has_more: false,
  },
};

/** Route by endpoint so one transport can serve the two-step cursor flow. */
function router(map: Record<string, NormalizedResponse>): (req: NormalizedRequest) => NormalizedResponse {
  return (req) => {
    for (const [needle, res] of Object.entries(map)) {
      if (req.url.includes(needle)) return res;
    }
    throw new Error(`unexpected request: ${req.url}`);
  };
}

describe('dropbox.new_file polling trigger', () => {
  it('baselines on first poll via get_latest_cursor, stores the cursor, fires nothing', async () => {
    const store = new MemoryStore();
    const transport = new FakeTransport(router({ get_latest_cursor: LATEST_CURSOR }));
    const result = await newFile.runPoll({ auth: stubAuth(transport), props: PROPS, store });

    expect(result.events).toEqual([]);
    expect(transport.requests[0]?.url).toContain('/files/list_folder/get_latest_cursor');
    expect(transport.requests[0]?.body).toEqual({
      path: '/Homework',
      recursive: true,
      include_deleted: false,
    });
    expect(store.snapshot().deltaCursor).toBe('AAF...BASELINE');
  });

  it('after the baseline, drains changes and emits only files (folders skipped)', async () => {
    const store = new MemoryStore();
    await newFile.runPoll({
      auth: stubAuth(new FakeTransport(router({ get_latest_cursor: LATEST_CURSOR }))),
      props: PROPS,
      store,
    });

    const transport = new FakeTransport(router({ 'list_folder/continue': CHANGES }));
    const result = await newFile.runPoll({ auth: stubAuth(transport), props: PROPS, store });

    expect(result.events).toEqual<DropboxFileEvent[]>([
      {
        id: 'id:a4ayc_80_OEAAAAAAAAAYa',
        name: 'Prime_Numbers.txt',
        pathLower: '/homework/math/prime_numbers.txt',
        pathDisplay: '/Homework/math/Prime_Numbers.txt',
        size: 7212,
        serverModified: '2026-07-20T15:50:38Z',
        rev: '015c7f4a2b',
        contentHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      },
    ]);
    // Cursor advanced, and the continue call replayed the stored baseline cursor.
    expect(transport.requests[0]?.body).toEqual({ cursor: 'AAF...BASELINE' });
    expect(store.snapshot().deltaCursor).toBe('AAF...ADVANCED');
  });

  it('dedupes by id:rev — the same file revision re-delivered fires once', async () => {
    const store = new MemoryStore();
    await newFile.runPoll({
      auth: stubAuth(new FakeTransport(router({ get_latest_cursor: LATEST_CURSOR }))),
      props: PROPS,
      store,
    });
    const first = await newFile.runPoll({
      auth: stubAuth(new FakeTransport(router({ 'list_folder/continue': CHANGES }))),
      props: PROPS,
      store,
    });
    const second = await newFile.runPoll({
      auth: stubAuth(new FakeTransport(router({ 'list_folder/continue': CHANGES }))),
      props: PROPS,
      store,
    });
    expect(first.events.map((e) => e.id)).toEqual(['id:a4ayc_80_OEAAAAAAAAAYa']);
    expect(second.events).toEqual([]);
  });
});
