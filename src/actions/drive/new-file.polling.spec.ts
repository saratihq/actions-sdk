import type { NormalizedResponse } from '../../core/http/types';
import { FakeTransport, stubAuth } from '../../testing/fakes';
import { MemoryStore } from '../../testing/memory-store';
import { type DriveFileEvent, newFile } from './new-file.polling';

const PROPS = { folderId: '0BwFolderId' };

/**
 * A REAL Google Drive `files.list` response (shape from the public files.list
 * docs): `{ files: [{ id, name, mimeType, createdTime, ... }] }`.
 */
const FILES_RESPONSE: NormalizedResponse = {
  status: 200,
  headers: {},
  data: {
    kind: 'drive#fileList',
    incompleteSearch: false,
    files: [
      {
        kind: 'drive#file',
        id: '1AbCdEfGhIjKlMnOpQrStUvWxYz',
        name: 'Q3 Report.pdf',
        mimeType: 'application/pdf',
        createdTime: '2026-07-20T10:00:00.000Z',
        modifiedTime: '2026-07-20T10:00:00.000Z',
        webViewLink: 'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz/view',
        parents: ['0BwFolderId'],
      },
    ],
  },
};

describe('drive.new_file polling trigger', () => {
  it('baselines on first poll: no watermark, fires nothing, no network call', async () => {
    const transport = new FakeTransport(() => {
      throw new Error('first poll must not call the network');
    });
    const result = await newFile.runPoll({
      auth: stubAuth(transport),
      props: PROPS,
      store: new MemoryStore(),
    });
    expect(result.events).toEqual([]);
    expect(transport.requests).toHaveLength(0);
  });

  it('after the baseline, lists files created since the watermark and normalises them', async () => {
    const store = new MemoryStore();
    await newFile.runPoll({
      auth: stubAuth(new FakeTransport(() => ({ status: 200, headers: {}, data: { files: [] } }))),
      props: PROPS,
      store,
    });

    const transport = new FakeTransport(() => FILES_RESPONSE);
    const result = await newFile.runPoll({ auth: stubAuth(transport), props: PROPS, store });

    expect(result.events).toEqual<DriveFileEvent[]>([
      {
        id: '1AbCdEfGhIjKlMnOpQrStUvWxYz',
        name: 'Q3 Report.pdf',
        mimeType: 'application/pdf',
        createdTime: '2026-07-20T10:00:00.000Z',
        modifiedTime: '2026-07-20T10:00:00.000Z',
        webViewLink: 'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz/view',
        parents: ['0BwFolderId'],
      },
    ]);

    // The read is a createdTime-scoped, folder-scoped Drive query.
    const q = decodeURIComponent(transport.requests[0]?.url ?? '').replace(/\+/g, ' ');
    expect(q).toContain("createdTime > '");
    expect(q).toContain('trashed = false');
    expect(q).toContain("'0BwFolderId' in parents");
    expect(q).toContain('orderBy=createdTime desc');
    // Shared-drive files must fire the trigger too.
    expect(q).toContain('supportsAllDrives=true');
    expect(q).toContain('includeItemsFromAllDrives=true');
  });

  it('dedupes by file id — a file already emitted never fires twice', async () => {
    const store = new MemoryStore();
    await newFile.runPoll({
      auth: stubAuth(new FakeTransport(() => ({ status: 200, headers: {}, data: { files: [] } }))),
      props: PROPS,
      store,
    });
    const first = await newFile.runPoll({
      auth: stubAuth(new FakeTransport(() => FILES_RESPONSE)),
      props: PROPS,
      store,
    });
    const second = await newFile.runPoll({
      auth: stubAuth(new FakeTransport(() => FILES_RESPONSE)),
      props: PROPS,
      store,
    });
    expect(first.events.map((e) => e.id)).toEqual(['1AbCdEfGhIjKlMnOpQrStUvWxYz']);
    expect(second.events).toEqual([]);
  });
});
