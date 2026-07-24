import { createHash, generateKeyPairSync } from 'node:crypto';

import { FakeTransport, stubAuth } from '../../testing/fakes';
import {
  base64Decode,
  base64Encode,
  cryptoActions,
  generatePassword,
  hashText,
  hmacSignature,
  rsaSignature,
} from './index';

const noAuth = stubAuth(new FakeTransport(() => ({ status: 200, headers: {}, data: {} })));

describe('crypto actions', () => {
  it('hashes text matching node crypto (hex + base64)', async () => {
    const expectedHex = createHash('sha256').update('hello', 'utf8').digest('hex');
    expect(await hashText.execute({ auth: noAuth, props: { text: 'hello', algorithm: 'sha256' } })).toEqual({
      hash: expectedHex,
    });
    const expectedB64 = createHash('md5').update('hello', 'utf8').digest('base64');
    expect(
      await hashText.execute({
        auth: noAuth,
        props: { text: 'hello', algorithm: 'md5', encoding: 'base64' },
      }),
    ).toEqual({ hash: expectedB64 });
  });

  it('computes a deterministic HMAC', async () => {
    const out1 = await hmacSignature.execute({
      auth: noAuth,
      props: { text: 'msg', key: 'secret', algorithm: 'sha256' },
    });
    const out2 = await hmacSignature.execute({
      auth: noAuth,
      props: { text: 'msg', key: 'secret', algorithm: 'sha256' },
    });
    expect(out1.signature).toBe(out2.signature);
    expect(out1.signature).toMatch(/^[0-9a-f]{64}$/);
  });

  it('round-trips base64', async () => {
    const enc = await base64Encode.execute({ auth: noAuth, props: { text: 'Hello, World!' } });
    expect(enc.result).toBe('SGVsbG8sIFdvcmxkIQ==');
    const dec = await base64Decode.execute({ auth: noAuth, props: { text: enc.result } });
    expect(dec.result).toBe('Hello, World!');
  });

  it('generates a password honouring length and character sets', async () => {
    const out = await generatePassword.execute({
      auth: noAuth,
      props: { length: 24, lowercase: false, uppercase: false, numbers: true, symbols: false },
    });
    expect(out.password).toHaveLength(24);
    expect(out.password).toMatch(/^[0-9]+$/);
  });

  it('rejects a password with no character set selected', async () => {
    await expect(
      generatePassword.execute({
        auth: noAuth,
        props: { lowercase: false, uppercase: false, numbers: false, symbols: false },
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('signs with an RSA private key', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const out = await rsaSignature.execute({
      auth: noAuth,
      props: { text: 'sign me', privateKey: pem, algorithm: 'sha256' },
    });
    expect(typeof out.signature).toBe('string');
    expect(out.signature.length).toBeGreaterThan(0);
  });

  it('surfaces an invalid RSA key as invalid_input', async () => {
    await expect(
      rsaSignature.execute({
        auth: noAuth,
        props: { text: 'x', privateKey: 'not-a-key', algorithm: 'sha256' },
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('exposes six actions, all crypto.* typed', () => {
    expect(cryptoActions).toHaveLength(6);
    for (const action of cryptoActions) expect(action.type.startsWith('crypto.')).toBe(true);
  });
});
