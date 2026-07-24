import { createHash, createHmac, createSign, randomInt } from 'node:crypto';

import { defineAction } from '../../core/action';
import { ActionError } from '../../core/errors';
import { checkbox, dropdown, longText, number, shortText } from '../../core/props';

/**
 * Crypto utilities — no-auth (`none` scheme) actions. Backed entirely by
 * Node's built-in `node:crypto`, so they stay dependency-free and run offline.
 * Type names are snake_case for the SDK namespace (which forbids hyphens).
 */

type TextEncoding = 'hex' | 'base64';

const hashAlgorithm = dropdown<string, true>({
  label: 'Algorithm',
  required: true,
  defaultValue: 'sha256',
  options: [
    { label: 'MD5', value: 'md5' },
    { label: 'SHA-1', value: 'sha1' },
    { label: 'SHA-256', value: 'sha256' },
    { label: 'SHA-512', value: 'sha512' },
  ],
});

const outputEncoding = dropdown<TextEncoding, false>({
  label: 'Output encoding',
  required: false,
  defaultValue: 'hex',
  options: [
    { label: 'Hex', value: 'hex' },
    { label: 'Base64', value: 'base64' },
  ],
});

export const HASH_TEXT_TYPE = 'crypto.hash_text';
export interface HashResult {
  hash: string;
}
export const hashText = defineAction({
  type: HASH_TEXT_TYPE,
  name: 'Text to Hash',
  description: 'Hash text with the selected algorithm.',
  auth: { type: 'none' },
  props: {
    text: longText({ label: 'Text', required: true }),
    algorithm: hashAlgorithm,
    encoding: outputEncoding,
  },
  run: ({ props }): Promise<HashResult> => {
    const hash = createHash(props.algorithm)
      .update(props.text, 'utf8')
      .digest(props.encoding ?? 'hex');
    return Promise.resolve({ hash });
  },
});

export const HMAC_TYPE = 'crypto.hmac_signature';
export interface HmacResult {
  signature: string;
}
export const hmacSignature = defineAction({
  type: HMAC_TYPE,
  name: 'Generate HMAC Signature',
  description: 'Compute an HMAC of the text with a secret key.',
  auth: { type: 'none' },
  props: {
    text: longText({ label: 'Text', required: true }),
    key: shortText({ label: 'Secret key', required: true }),
    algorithm: hashAlgorithm,
    encoding: outputEncoding,
  },
  run: ({ props }): Promise<HmacResult> => {
    const signature = createHmac(props.algorithm, props.key)
      .update(props.text, 'utf8')
      .digest(props.encoding ?? 'hex');
    return Promise.resolve({ signature });
  },
});

export const RSA_TYPE = 'crypto.rsa_signature';
export interface RsaResult {
  signature: string;
}
export const rsaSignature = defineAction({
  type: RSA_TYPE,
  name: 'Generate RSA Signature',
  description: 'Sign text with an RSA private key (PEM).',
  auth: { type: 'none' },
  props: {
    text: longText({ label: 'Text', required: true }),
    privateKey: longText({ label: 'Private key (PEM)', required: true }),
    algorithm: dropdown<string, true>({
      label: 'Hash algorithm',
      required: true,
      defaultValue: 'sha256',
      options: [
        { label: 'SHA-256', value: 'sha256' },
        { label: 'SHA-384', value: 'sha384' },
        { label: 'SHA-512', value: 'sha512' },
      ],
    }),
  },
  run: ({ props }): Promise<RsaResult> => {
    try {
      const signature = createSign(props.algorithm)
        .update(props.text, 'utf8')
        .sign(props.privateKey, 'base64');
      return Promise.resolve({ signature });
    } catch (err) {
      throw new ActionError({
        code: 'invalid_input',
        message: `RSA signing failed: ${err instanceof Error ? err.message : String(err)}`,
        retryable: false,
      });
    }
  },
});

export const GENERATE_PASSWORD_TYPE = 'crypto.generate_password';
export interface PasswordResult {
  password: string;
}
const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const DIGITS = '0123456789';
const SYMBOLS = '!@#$%^&*()-_=+[]{};:,.<>?';
export const generatePassword = defineAction({
  type: GENERATE_PASSWORD_TYPE,
  name: 'Generate Password',
  description: 'Generate a cryptographically-random password.',
  auth: { type: 'none' },
  props: {
    length: number({ label: 'Length', required: false, defaultValue: 16 }),
    lowercase: checkbox({ label: 'Include lowercase', required: false, defaultValue: true }),
    uppercase: checkbox({ label: 'Include uppercase', required: false, defaultValue: true }),
    numbers: checkbox({ label: 'Include numbers', required: false, defaultValue: true }),
    symbols: checkbox({ label: 'Include symbols', required: false, defaultValue: false }),
  },
  run: ({ props }): Promise<PasswordResult> => {
    const length = Math.floor(props.length ?? 16);
    if (length < 1) {
      throw new ActionError({
        code: 'invalid_input',
        message: 'length must be at least 1',
        retryable: false,
      });
    }
    let charset = '';
    if (props.lowercase ?? true) charset += LOWER;
    if (props.uppercase ?? true) charset += UPPER;
    if (props.numbers ?? true) charset += DIGITS;
    if (props.symbols ?? false) charset += SYMBOLS;
    if (charset.length === 0) {
      throw new ActionError({
        code: 'invalid_input',
        message: 'select at least one character set',
        retryable: false,
      });
    }
    let password = '';
    for (let i = 0; i < length; i++) password += charset.charAt(randomInt(charset.length));
    return Promise.resolve({ password });
  },
});

export const BASE64_ENCODE_TYPE = 'crypto.base64_encode';
export interface EncodeResult {
  result: string;
}
export const base64Encode = defineAction({
  type: BASE64_ENCODE_TYPE,
  name: 'Base64 Encode',
  description: 'Encode text as Base64.',
  auth: { type: 'none' },
  props: { text: longText({ label: 'Text', required: true }) },
  run: ({ props }): Promise<EncodeResult> =>
    Promise.resolve({ result: Buffer.from(props.text, 'utf8').toString('base64') }),
});

export const BASE64_DECODE_TYPE = 'crypto.base64_decode';
export interface DecodeResult {
  result: string;
}
export const base64Decode = defineAction({
  type: BASE64_DECODE_TYPE,
  name: 'Base64 Decode',
  description: 'Decode Base64 text back to a UTF-8 string.',
  auth: { type: 'none' },
  props: { text: longText({ label: 'Base64 text', required: true }) },
  run: ({ props }): Promise<DecodeResult> =>
    Promise.resolve({ result: Buffer.from(props.text, 'base64').toString('utf8') }),
});
