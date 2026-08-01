import { HttpClient } from '../../core/http/client';
import type { NormalizedRequest, NormalizedResponse } from '../../core/http/types';
import { FakeTransport, stubAuth } from '../../testing/fakes';
import { createFolder, getFile, listFiles } from './files';

/** Golden offline tests for the Google Drive actions, driven by a {@link FakeTransport}. */
function fake(handler: (req: NormalizedRequest, i: number) => NormalizedResponse) {
  const transport = new FakeTransport(handler);
  return { auth: stubAuth(transport, 'oauth2'), http: new HttpClient(), transport };
}

describe('drive.list_files', () => {
  it('defaults to non-trashed and follows nextPageToken up to the limit', async () => {
    const { auth, http, transport } = fake((_req, i) =>
      i === 0
        ? {
            status: 200,
            headers: {},
            data: { files: [{ id: 'f1', name: 'a', mimeType: 'text/plain' }], nextPageToken: 'NP' },
          }
        : { status: 200, headers: {}, data: { files: [{ id: 'f2', name: 'b', mimeType: 'text/plain' }] } },
    );
    const out = await listFiles.execute({ auth, http, props: { limit: 100 } });
    expect(out.count).toBe(2);
    const first = transport.requests[0]!.url;
    expect(decodeURIComponent(first)).toContain('q=trashed=false');
    // Shared-drive items are included, not just My Drive.
    expect(first).toContain('supportsAllDrives=true');
    expect(first).toContain('includeItemsFromAllDrives=true');
    expect(transport.requests[1]!.url).toContain('pageToken=NP');
  });

  it('passes a raw query through verbatim', async () => {
    const { auth, http, transport } = fake(() => ({ status: 200, headers: {}, data: { files: [] } }));
    await listFiles.execute({ auth, http, props: { query: "name contains 'report'" } });
    // The raw query is passed through verbatim (spaces encode as '+', kept here).
    expect(decodeURIComponent(transport.requests[0]!.url)).toContain("q=name+contains+'report'");
  });
});

describe('drive.get_file', () => {
  it('GETs metadata by id with the fields mask', async () => {
    const { auth, http, transport } = fake(() => ({
      status: 200,
      headers: {},
      data: { id: 'f1', name: 'Doc', mimeType: 'application/vnd.google-apps.document' },
    }));
    const out = await getFile.execute({ auth, http, props: { fileId: 'f1' } });
    expect(out.name).toBe('Doc');
    expect(transport.requests[0]!.url).toContain('/files/f1');
    expect(transport.requests[0]!.url).toContain('fields=');
    // Resolve ids that live on a shared drive, not just My Drive.
    expect(transport.requests[0]!.url).toContain('supportsAllDrives=true');
  });
});

describe('drive.create_folder', () => {
  it('POSTs the folder mimeType and optional parent', async () => {
    const { auth, http, transport } = fake(() => ({
      status: 200,
      headers: {},
      data: { id: 'fold1', name: 'Reports', mimeType: 'application/vnd.google-apps.folder' },
    }));
    const out = await createFolder.execute({ auth, http, props: { name: 'Reports', parentId: 'root1' } });
    expect(out.id).toBe('fold1');
    expect(transport.requests[0]!.body).toEqual({
      name: 'Reports',
      mimeType: 'application/vnd.google-apps.folder',
      parents: ['root1'],
    });
    // Accept a shared-drive parent, not just a My Drive folder.
    expect(transport.requests[0]!.url).toContain('supportsAllDrives=true');
  });
});
