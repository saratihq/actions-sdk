import { createHash } from 'node:crypto';

import { createDirectAuth } from '../auth-factories';
import { liveDescribe } from '../../testing/live';
import { HttpClient } from './client';

/** LIVE download → pass → upload proof over the direct transport against httpbin.org; gated behind ORCHESTR_LIVE. */
liveDescribe('file rail — live download → multipart upload (httpbin, direct rail)', () => {
  const auth = createDirectAuth({ type: 'none' }, { type: 'none' });
  const http = new HttpClient({ defaultTimeoutMs: 20_000 });
  const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

  it('downloads real bytes, uploads them as multipart, and the round-trip checksum matches', async () => {
    // A — download real binary.
    const download = await http.get<Buffer>('https://httpbin.org/image/png', {
      auth,
      responseType: 'binary',
    });
    expect(Buffer.isBuffer(download.data)).toBe(true);
    const bytes = download.data;
    expect(bytes.byteLength).toBeGreaterThan(1000);
    // PNG magic — proves we got the raw image, not a text-decoded body.
    expect(bytes.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const downloadedSha = sha(bytes);

    // B — upload the SAME bytes as multipart/form-data.
    const upload = await http.post<{ files?: Record<string, string>; form?: Record<string, string> }>(
      'https://httpbin.org/post',
      {
        auth,
        multipart: {
          fields: { title: 'orchestr file-rail live' },
          files: { file: { filename: 'image.png', data: bytes, mimeType: 'image/png' } },
        },
      },
    );

    // httpbin echoes the received file as a data: URL (base64). Decode → checksum.
    const echoed = upload.data.files?.file;
    expect(typeof echoed).toBe('string');
    const b64 = (echoed as string).split(',').pop() ?? '';
    const roundTripped = Buffer.from(b64, 'base64');
    const roundTrippedSha = sha(roundTripped);

    expect(upload.data.form?.title).toBe('orchestr file-rail live');
    expect(roundTripped.byteLength).toBe(bytes.byteLength);
    expect(roundTrippedSha).toBe(downloadedSha);

    console.log(
      `live: file rail → downloaded ${bytes.byteLength}B sha256=${downloadedSha.slice(0, 12)}…, ` +
        `multipart round-trip checksum ${roundTrippedSha === downloadedSha ? 'MATCH' : 'MISMATCH'}`,
    );
  }, 40_000);
});
