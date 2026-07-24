import { HttpClient } from '../../core/http/client';
import type { FetchLike, FetchLikeResponse } from '../../core/http/types';
import { fakeResponse, stubAuth } from '../../testing/fakes';
import { DirectTransport } from '../../core/http/transport-direct';
import { slackOAuth } from './common';
import { getFile } from './get-file';
import { uploadFile } from './upload-file';

/**
 * The Slack file actions over the DIRECT transport (the only transport files
 * ride). A route table drives an injected fetch so the two-/three-hop flows are
 * exercised deterministically — no network — covering the binary-download decode
 * and the multipart-upload body shape.
 */
function directAuth(routes: (url: string, init: Parameters<FetchLike>[1]) => FetchLikeResponse) {
  const calls: Array<{ url: string; init: Parameters<FetchLike>[1] }> = [];
  const fetchImpl: FetchLike = (input, init) => {
    calls.push({ url: String(input), init });
    return Promise.resolve(routes(String(input), init));
  };
  const transport = new DirectTransport({
    scheme: slackOAuth,
    credential: { type: 'bearer', token: 'xoxb-test-token' },
    fetchImpl,
  });
  return { auth: stubAuth(transport, 'oauth2'), calls, http: new HttpClient() };
}

const json = (body: unknown): FetchLikeResponse =>
  fakeResponse(200, JSON.stringify(body), { 'content-type': 'application/json' });

describe('slack.get_file — binary download', () => {
  it('resolves the private URL then downloads the raw bytes intact', async () => {
    // Bytes that are not valid UTF-8, so a text decode anywhere would corrupt them.
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00, 0x01]);
    const { auth, http, calls } = directAuth((url) => {
      if (url.includes('/files.info')) {
        return json({
          ok: true,
          file: {
            id: 'F123',
            name: 'diagram.png',
            mimetype: 'image/png',
            url_private_download: 'https://files.slack.test/diagram.png',
          },
        });
      }
      if (url.startsWith('https://files.slack.test/')) {
        return fakeResponse(200, png, { 'content-type': 'image/png' });
      }
      throw new Error(`unexpected url ${url}`);
    });

    const out = await getFile.execute({ auth, http, props: { fileId: 'F123' } });
    expect(out.name).toBe('diagram.png');
    expect(out.mimetype).toBe('image/png');
    expect(out.size).toBe(png.length);
    expect(Buffer.isBuffer(out.file.data)).toBe(true);
    expect(out.file.data).toEqual(png);
    // The bearer token rode to the (different-host) download URL.
    const download = calls.find((c) => c.url.startsWith('https://files.slack.test/'));
    expect(download?.init?.headers?.['authorization']).toBe('Bearer xoxb-test-token');
  });

  it('fails loudly (provider_error) when the file has no downloadable URL', async () => {
    const { auth, http } = directAuth(() => json({ ok: true, file: { id: 'F1', name: 'x' } }));
    await expect(getFile.execute({ auth, http, props: { fileId: 'F1' } })).rejects.toMatchObject({
      code: 'provider_error',
    });
  });
});

describe('slack.upload_file — multipart upload', () => {
  it('reserves an upload URL, POSTs the bytes as multipart, then completes', async () => {
    const bytes = Buffer.from('the real report bytes');
    let uploadInit: Parameters<FetchLike>[1] | undefined;
    const { auth, http, calls } = directAuth((url, init) => {
      if (url.includes('/files.getUploadURLExternal')) {
        return json({ ok: true, upload_url: 'https://files-upload.slack.test/u1', file_id: 'F999' });
      }
      if (url.startsWith('https://files-upload.slack.test/')) {
        uploadInit = init;
        return fakeResponse(200, 'OK', { 'content-type': 'text/plain' });
      }
      if (url.includes('/files.completeUploadExternal')) {
        return json({ ok: true, files: [{ id: 'F999', title: 'report.txt' }] });
      }
      throw new Error(`unexpected url ${url}`);
    });

    const out = await uploadFile.execute({
      auth,
      http,
      props: {
        channel: 'C123',
        file: { filename: 'report.txt', data: bytes, mimeType: 'text/plain' },
        title: 'report.txt',
      },
    });

    expect(out.ok).toBe(true);
    expect(out.files?.[0]?.id).toBe('F999');

    // The upload hop carried a real multipart body with the exact bytes.
    expect(String(uploadInit?.headers?.['content-type'])).toMatch(/^multipart\/form-data; boundary=/);
    const wire = uploadInit?.body as Buffer;
    expect(Buffer.isBuffer(wire)).toBe(true);
    expect(wire.includes(bytes)).toBe(true);
    expect(wire.toString('latin1')).toContain('filename="report.txt"');

    // getUploadURLExternal was told the real byte length.
    const reserve = calls.find((c) => c.url.includes('/files.getUploadURLExternal'));
    expect(reserve?.url).toContain(`length=${bytes.byteLength}`);
  });
});
