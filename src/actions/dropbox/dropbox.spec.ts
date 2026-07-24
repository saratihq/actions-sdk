import { HttpClient } from '../../core/http/client';
import type { NormalizedRequest, NormalizedResponse } from '../../core/http/types';
import { FakeTransport, stubAuth } from '../../testing/fakes';
import { createFolder, getFileMetadata, getTemporaryLink, listFolder, search } from './files';

/**
 * Golden offline tests for the Dropbox actions. A {@link FakeTransport} replays
 * canned API v2 responses and records requests, asserting the RPC endpoints, the
 * JSON bodies, the `list_folder`/`continue` cursor loop, and the nested
 * `search_v2` / `create_folder_v2` envelope unwrapping without a connection.
 */
function fake(handler: (req: NormalizedRequest, i: number) => NormalizedResponse) {
  const transport = new FakeTransport(handler);
  return { auth: stubAuth(transport, 'oauth2'), http: new HttpClient(), transport };
}

describe('dropbox.list_dropbox_folder', () => {
  it('defaults to the root path and follows the continue cursor up to the limit', async () => {
    const { auth, http, transport } = fake((_req, i) =>
      i === 0
        ? {
            status: 200,
            headers: {},
            data: { entries: [{ '.tag': 'file', name: 'a.txt' }], cursor: 'C1', has_more: true },
          }
        : {
            status: 200,
            headers: {},
            data: { entries: [{ '.tag': 'folder', name: 'sub' }], has_more: false },
          },
    );
    const out = await listFolder.execute({ auth, http, props: { limit: 100 } });
    expect(out.count).toBe(2);
    // First call hits list_folder with path "" (root); second follows the cursor.
    expect(transport.requests[0]!.url).toBe('https://api.dropboxapi.com/2/files/list_folder');
    expect(transport.requests[0]!.body).toEqual({ path: '', recursive: false });
    expect(transport.requests[1]!.url).toBe('https://api.dropboxapi.com/2/files/list_folder/continue');
    expect(transport.requests[1]!.body).toEqual({ cursor: 'C1' });
  });

  it('stops at the item limit without following a further cursor', async () => {
    const { auth, http, transport } = fake(() => ({
      status: 200,
      headers: {},
      data: {
        entries: [
          { '.tag': 'file', name: 'a' },
          { '.tag': 'file', name: 'b' },
        ],
        cursor: 'C',
        has_more: true,
      },
    }));
    const out = await listFolder.execute({ auth, http, props: { path: '/Docs', limit: 1 } });
    expect(out.count).toBe(1);
    expect(transport.requests).toHaveLength(1); // limit reached on page 1 — no continue
    expect(transport.requests[0]!.body).toEqual({ path: '/Docs', recursive: false });
  });
});

describe('dropbox.get_file_metadata', () => {
  it('POSTs the path to get_metadata', async () => {
    const { auth, http, transport } = fake(() => ({
      status: 200,
      headers: {},
      data: { '.tag': 'file', name: 'report.pdf', id: 'id:1', size: 1024 },
    }));
    const out = await getFileMetadata.execute({ auth, http, props: { path: '/Docs/report.pdf' } });
    expect(out.name).toBe('report.pdf');
    expect(out.size).toBe(1024);
    expect(transport.requests[0]!.url).toBe('https://api.dropboxapi.com/2/files/get_metadata');
    expect(transport.requests[0]!.body).toEqual({ path: '/Docs/report.pdf' });
  });
});

describe('dropbox.create_new_dropbox_folder', () => {
  it('POSTs create_folder_v2 and unwraps the metadata envelope', async () => {
    const { auth, http, transport } = fake(() => ({
      status: 200,
      headers: {},
      data: { metadata: { '.tag': 'folder', name: '2026', id: 'id:9', path_display: '/Reports/2026' } },
    }));
    const out = await createFolder.execute({ auth, http, props: { path: '/Reports/2026' } });
    expect(out.name).toBe('2026');
    expect(out.path_display).toBe('/Reports/2026');
    expect(transport.requests[0]!.url).toBe('https://api.dropboxapi.com/2/files/create_folder_v2');
    expect(transport.requests[0]!.body).toEqual({ path: '/Reports/2026', autorename: false });
  });
});

describe('dropbox.search_dropbox', () => {
  it('POSTs search_v2 and flattens the nested match metadata', async () => {
    const { auth, http, transport } = fake(() => ({
      status: 200,
      headers: {},
      data: {
        matches: [
          { metadata: { metadata: { '.tag': 'file', name: 'q1.xlsx' } } },
          { metadata: { metadata: { '.tag': 'file', name: 'q2.xlsx' } } },
        ],
        has_more: false,
      },
    }));
    const out = await search.execute({ auth, http, props: { query: 'q', path: '/Finance', max: 50 } });
    expect(out.count).toBe(2);
    expect(out.hasMore).toBe(false);
    expect(out.entries[0]!.name).toBe('q1.xlsx');
    expect(transport.requests[0]!.url).toBe('https://api.dropboxapi.com/2/files/search_v2');
    expect(transport.requests[0]!.body).toEqual({
      query: 'q',
      options: { max_results: 50, path: '/Finance' },
    });
  });

  it('omits the path option when searching the whole account', async () => {
    const { auth, http, transport } = fake(() => ({ status: 200, headers: {}, data: { matches: [] } }));
    await search.execute({ auth, http, props: { query: 'invoice' } });
    expect(transport.requests[0]!.body).toEqual({ query: 'invoice', options: { max_results: 100 } });
  });
});

describe('dropbox.get_dropbox_file_link', () => {
  it('POSTs get_temporary_link and returns the link + metadata', async () => {
    const { auth, http, transport } = fake(() => ({
      status: 200,
      headers: {},
      data: { metadata: { '.tag': 'file', name: 'report.pdf' }, link: 'https://dl.dropboxusercontent.com/x' },
    }));
    const out = await getTemporaryLink.execute({ auth, http, props: { path: '/Docs/report.pdf' } });
    expect(out.link).toBe('https://dl.dropboxusercontent.com/x');
    expect(out.metadata.name).toBe('report.pdf');
    expect(transport.requests[0]!.url).toBe('https://api.dropboxapi.com/2/files/get_temporary_link');
    expect(transport.requests[0]!.body).toEqual({ path: '/Docs/report.pdf' });
  });
});
