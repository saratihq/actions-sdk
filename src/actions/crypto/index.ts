export {
  BASE64_DECODE_TYPE,
  BASE64_ENCODE_TYPE,
  base64Decode,
  base64Encode,
  type DecodeResult,
  type EncodeResult,
  GENERATE_PASSWORD_TYPE,
  generatePassword,
  HASH_TEXT_TYPE,
  HMAC_TYPE,
  type HashResult,
  hashText,
  type HmacResult,
  hmacSignature,
  type PasswordResult,
  RSA_TYPE,
  type RsaResult,
  rsaSignature,
} from './crypto';

import {
  base64Decode,
  base64Encode,
  generatePassword,
  hashText,
  hmacSignature,
  rsaSignature,
} from './crypto';

/** Every Crypto action, for catalog builds and registration. */
export const cryptoActions = [
  hashText,
  hmacSignature,
  rsaSignature,
  generatePassword,
  base64Encode,
  base64Decode,
] as const;
