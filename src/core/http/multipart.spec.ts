import { ActionError } from '../errors';
import { buildMultipart, encodeMultipart } from './multipart';
import { isMultipartBody } from './types';

describe('buildMultipart', () => {
  it('brands the body so a plain JSON object cannot masquerade as one', () => {
    const body = buildMultipart({ fields: { a: '1' } });
    expect(isMultipartBody(body)).toBe(true);
    expect(isMultipartBody({ kind: 'multipart', parts: [] })).toBe(false);
    expect(isMultipartBody({ a: 1 })).toBe(false);
  });

  it('stringifies scalar fields and drops null/undefined', () => {
    const body = buildMultipart({
      fields: { name: 'report', count: 3, flag: true, skip: undefined, none: null },
    });
    expect(body.parts).toEqual([
      { type: 'field', name: 'name', value: 'report' },
      { type: 'field', name: 'count', value: '3' },
      { type: 'field', name: 'flag', value: 'true' },
    ]);
  });

  it('carries file parts as bytes with filename + content-type', () => {
    const data = Buffer.from('PNGDATA');
    const body = buildMultipart({ files: { file: { filename: 'a.png', data, mimeType: 'image/png' } } });
    expect(body.parts).toEqual([
      { type: 'file', name: 'file', filename: 'a.png', data, contentType: 'image/png' },
    ]);
  });

  it('rejects a file part whose data is not a Buffer (loud, non-retryable)', () => {
    expect(() =>
      buildMultipart({ files: { file: { filename: 'x', data: 'not-bytes' as unknown as Buffer } } }),
    ).toThrow(ActionError);
  });
});

describe('encodeMultipart', () => {
  it('encodes fields + a binary file into a parseable multipart body with a matching boundary', () => {
    const bytes = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]);
    const body = buildMultipart({
      fields: { channels: 'C123', title: 'Q4' },
      files: { file: { filename: 'r.bin', data: bytes, mimeType: 'application/octet-stream' } },
    });
    const { body: wire, contentType } = encodeMultipart(body);

    const boundary = /boundary=(.+)$/.exec(contentType)?.[1];
    expect(boundary).toBeTruthy();
    expect(Buffer.isBuffer(wire)).toBe(true);

    const text = wire.toString('latin1');
    expect(text).toContain(`--${boundary}\r\n`);
    expect(text).toContain('Content-Disposition: form-data; name="channels"\r\n\r\nC123\r\n');
    expect(text).toContain('Content-Disposition: form-data; name="file"; filename="r.bin"');
    expect(text).toContain('Content-Type: application/octet-stream');
    expect(text.endsWith(`--${boundary}--\r\n`)).toBe(true);

    // The raw file bytes survive verbatim (never text-mangled).
    const marker = 'application/octet-stream\r\n\r\n';
    const start = wire.indexOf(marker) + marker.length;
    expect(wire.subarray(start, start + bytes.length)).toEqual(bytes);
  });

  it('defaults a file part with no content-type to application/octet-stream', () => {
    const body = buildMultipart({ files: { f: { filename: 'x', data: Buffer.from('hi') } } });
    expect(encodeMultipart(body).body.toString('latin1')).toContain('Content-Type: application/octet-stream');
  });

  it('escapes CR/LF/quotes in names so a crafted filename cannot inject header parts', () => {
    const body = buildMultipart({
      files: { f: { filename: 'a"\r\nContent-Disposition: evil', data: Buffer.from('x') } },
    });
    const text = encodeMultipart(body).body.toString('latin1');
    // The only real Content-Disposition line is the one part header; the injected
    // one is percent-escaped, not a second header.
    expect(text.match(/\r\nContent-Disposition:/g)?.length).toBe(1);
    expect(text).toContain('%22%0D%0A');
  });

  it('produces a fresh random boundary each call', () => {
    const body = buildMultipart({ fields: { a: '1' } });
    expect(encodeMultipart(body).contentType).not.toEqual(encodeMultipart(body).contentType);
  });
});
