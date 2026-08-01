import { fakeFetch, fakeResponse } from '../../testing/fakes';
import { buildMultipart } from './multipart';
import { DirectTransport } from './transport-direct';
import type { NormalizedRequest } from './types';

/** The file/binary path on the direct transport: raw bytes over the wire, never text-decoded. */

describe('DirectTransport — multipart upload', () => {
  it('encodes a multipart body to raw bytes over the wire with a boundary content-type', async () => {
    const fetchImpl = fakeFetch(() => fakeResponse(200, 'OK', { 'content-type': 'text/plain' }));
    const t = new DirectTransport({ scheme: { type: 'none' }, credential: { type: 'none' }, fetchImpl });
    const bytes = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
    const req: NormalizedRequest = {
      method: 'POST',
      url: 'https://up.test/x',
      headers: {},
      body: buildMultipart({ fields: { title: 'r' }, files: { file: { filename: 'r.bin', data: bytes } } }),
    };
    await t.send(req);

    const init = fetchImpl.calls[0]?.init;
    expect(String(init?.headers?.['content-type'])).toMatch(/^multipart\/form-data; boundary=----orchestr-/);
    expect(Buffer.isBuffer(init?.body)).toBe(true);
    const wire = init?.body as Buffer;
    // The raw upload bytes survive verbatim inside the encoded body.
    expect(wire.includes(bytes)).toBe(true);
    expect(wire.toString('latin1')).toContain('filename="r.bin"');
  });
});

describe('DirectTransport — binary download', () => {
  it('returns the raw response bytes as a Buffer, never text-decoded', async () => {
    // Bytes that are NOT valid UTF-8 — a text decode would corrupt them.
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x00]);
    const fetchImpl = fakeFetch(() => fakeResponse(200, png, { 'content-type': 'image/png' }));
    const t = new DirectTransport({ scheme: { type: 'none' }, credential: { type: 'none' }, fetchImpl });

    const res = await t.send({
      method: 'GET',
      url: 'https://dl.test/x.png',
      headers: {},
      responseType: 'binary',
    });
    expect(Buffer.isBuffer(res.data)).toBe(true);
    expect(res.data).toEqual(png);
  });

  it('still parses JSON when responseType is not binary', async () => {
    const fetchImpl = fakeFetch(() =>
      fakeResponse(200, '{"ok":true}', { 'content-type': 'application/json' }),
    );
    const t = new DirectTransport({ scheme: { type: 'none' }, credential: { type: 'none' }, fetchImpl });
    const res = await t.send({ method: 'GET', url: 'https://dl.test/x', headers: {} });
    expect(res.data).toEqual({ ok: true });
  });
});
