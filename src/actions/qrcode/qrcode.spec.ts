import { FakeTransport, stubAuth } from '../../testing/fakes';
import { qrcodeActions, textToQrcode } from './index';

const noAuth = stubAuth(new FakeTransport(() => ({ status: 200, headers: {}, data: {} })));

/** PNG files start with an 8-byte signature; bytes 1–3 spell "PNG". */
function isPng(data: Buffer): boolean {
  return data.length > 8 && data.subarray(1, 4).toString('ascii') === 'PNG';
}

describe('qrcode actions', () => {
  it('encodes text into a QR-code PNG', async () => {
    const out = await textToQrcode.execute({ auth: noAuth, props: { text: 'https://orchestr.dev' } });
    expect(isPng(out.file.data)).toBe(true);
    expect(out.mimetype).toBe('image/png');
    expect(out.name).toBe('qr-code.png');
    expect(out.size).toBe(out.file.data.byteLength);
    expect(out.size).toBeGreaterThan(0);
  });

  it('honours the error-correction level and margin options', async () => {
    const low = await textToQrcode.execute({
      auth: noAuth,
      props: { text: 'same', errorCorrectionLevel: 'L' },
    });
    const high = await textToQrcode.execute({
      auth: noAuth,
      props: { text: 'same', errorCorrectionLevel: 'H' },
    });
    const tight = await textToQrcode.execute({ auth: noAuth, props: { text: 'same', margin: 0 } });
    for (const out of [low, high, tight]) expect(isPng(out.file.data)).toBe(true);
    // A denser error-correction level changes the encoded matrix, so the bytes differ.
    expect(high.file.data.equals(low.file.data)).toBe(false);
  });

  it('rejects empty content', async () => {
    await expect(textToQrcode.execute({ auth: noAuth, props: { text: '' } })).rejects.toMatchObject({
      code: 'invalid_input',
    });
  });

  it('exposes one action, qrcode.* typed', () => {
    expect(qrcodeActions).toHaveLength(1);
    for (const action of qrcodeActions) expect(action.type.startsWith('qrcode.')).toBe(true);
  });
});
