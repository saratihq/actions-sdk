import { FORM, type FormBody } from './types';

/**
 * `application/x-www-form-urlencoded` — the body encoding some providers require
 * for writes (Stripe's `/v1/*` REST API is the canonical case: it takes NO JSON,
 * only form bodies with bracketed nested params). The direct transport turns a
 * {@link FormBody} into a `key=value&…` string; the managed proxy rejects it
 * (JSON only). Kept in one audited place — the form counterpart of `multipart.ts`
 * — so every form action encodes identically and no action hand-rolls the escape.
 */

/** A scalar a form field may carry (numbers/booleans are stringified — form values are text). */
export type FormScalar = string | number | boolean;

/**
 * The ergonomic shape an action passes to `http`'s `form` option. An array value
 * expands to bracket-indexed keys (`key[0]=…&key[1]=…`) — the serialisation
 * Stripe (and most form APIs) expect for repeated params; `undefined`/`null` are
 * dropped so optional params need no pre-filtering.
 */
export type FormInput = Record<string, FormScalar | ReadonlyArray<FormScalar> | undefined | null>;

/**
 * Build a {@link FormBody} from the ergonomic input: flatten every entry to
 * `[key, stringValue]` pairs (arrays expanded to `key[i]`, scalars stringified),
 * dropping null/undefined. Insertion order is preserved. The URL-escaping itself
 * lives in {@link encodeForm} (the transport), mirroring multipart's build/encode
 * split — so the flattening is unit-testable without a transport.
 */
export function buildForm(input: FormInput): FormBody {
  const fields: Array<readonly [string, string]> = [];
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      (value as ReadonlyArray<FormScalar>).forEach((item, index) => {
        fields.push([`${key}[${index}]`, String(item)]);
      });
    } else {
      fields.push([key, String(value)]);
    }
  }
  return { [FORM]: true, fields };
}

/**
 * Encode a {@link FormBody} to the wire: `key=value` pairs joined by `&`, with
 * both sides percent-encoded (`encodeURIComponent`, which escapes `&`, `=`, and
 * the reserved chars a raw value could otherwise inject). The matching
 * `Content-Type: application/x-www-form-urlencoded` header is set by the transport.
 */
export function encodeForm(body: FormBody): string {
  return body.fields
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
}
