import { FORM, type FormBody } from './types';

/** A scalar a form field may carry (numbers/booleans are stringified — form values are text). */
export type FormScalar = string | number | boolean;

/** The ergonomic shape for `http`'s `form` option; arrays expand to `key[0]=…` and null/undefined are dropped. */
export type FormInput = Record<string, FormScalar | ReadonlyArray<FormScalar> | undefined | null>;

/** Flatten the input to ordered `[key, stringValue]` pairs; the URL-escaping itself lives in {@link encodeForm}. */
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

/** Encode a {@link FormBody} to `key=value&…` with both sides percent-encoded; the transport sets the Content-Type. */
export function encodeForm(body: FormBody): string {
  return body.fields
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
}
