import { randomBytes } from 'node:crypto';

import { ActionError } from '../errors';
import { MULTIPART, type MultipartBody, type MultipartPart } from './types';

/**
 * multipart/form-data — the file-upload encoding (RFC 7578). The direct
 * transport turns a {@link MultipartBody} into raw bytes over the wire; the
 * managed proxy rejects it (JSON only). Kept in one audited place so every
 * upload action encodes identically and no action hand-rolls a boundary.
 */

/** The ergonomic shape an action passes to `http`'s `multipart` option. */
export interface MultipartInput {
  /** Scalar form fields. Numbers/booleans are stringified (form fields are text). */
  fields?: Record<string, string | number | boolean | undefined | null>;
  /** File parts, keyed by form field name. */
  files?: Record<string, MultipartFileInput | undefined | null>;
}

/** One file part: bytes plus the metadata a provider needs to store it. */
export interface MultipartFileInput {
  filename: string;
  data: Buffer;
  /** MIME type; defaults to `application/octet-stream`. */
  mimeType?: string;
}

/**
 * Build a {@link MultipartBody} from the ergonomic input. Field order is
 * preserved (fields first, then files) — some providers are order-sensitive.
 * Throws `invalid_input` for a file part whose bytes are not a Buffer, so a
 * mis-wired upload fails loudly at the boundary instead of sending garbage.
 */
export function buildMultipart(input: MultipartInput): MultipartBody {
  const parts: MultipartPart[] = [];
  for (const [name, value] of Object.entries(input.fields ?? {})) {
    if (value === undefined || value === null) continue;
    parts.push({ type: 'field', name, value: String(value) });
  }
  for (const [name, file] of Object.entries(input.files ?? {})) {
    if (file === undefined || file === null) continue;
    if (!Buffer.isBuffer(file.data)) {
      throw new ActionError({
        code: 'invalid_input',
        message: `multipart file "${name}" must carry bytes as a Buffer`,
        retryable: false,
        detail: { field: name },
      });
    }
    parts.push({
      type: 'file',
      name,
      filename: file.filename,
      data: file.data,
      ...(file.mimeType ? { contentType: file.mimeType } : {}),
    });
  }
  return { [MULTIPART]: true, parts };
}

/**
 * Encode a {@link MultipartBody} to the wire: a single `Buffer` and the matching
 * `Content-Type` header carrying the boundary. The boundary is random (48 bits)
 * and prefixed so it cannot collide with real content — the one correctness risk
 * a multipart encoder has.
 */
export function encodeMultipart(body: MultipartBody): { body: Buffer; contentType: string } {
  const boundary = `----orchestr-${randomBytes(16).toString('hex')}`;
  const CRLF = '\r\n';
  const chunks: Buffer[] = [];

  for (const part of body.parts) {
    let header = `--${boundary}${CRLF}Content-Disposition: form-data; name="${escapeName(part.name)}"`;
    if (part.type === 'file') {
      header += `; filename="${escapeName(part.filename)}"${CRLF}`;
      header += `Content-Type: ${part.contentType ?? 'application/octet-stream'}`;
    }
    header += CRLF + CRLF;
    chunks.push(Buffer.from(header, 'utf8'));
    chunks.push(part.type === 'file' ? part.data : Buffer.from(part.value, 'utf8'));
    chunks.push(Buffer.from(CRLF, 'utf8'));
  }
  chunks.push(Buffer.from(`--${boundary}--${CRLF}`, 'utf8'));

  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

/**
 * Sanitise a field/filename for a Content-Disposition header. Quotes and CR/LF
 * would let a crafted name break out of the header and inject parts (header
 * injection); percent-encode them, matching how browsers escape these.
 */
function escapeName(name: string): string {
  return name.replace(/[\r\n"]/g, (c) => encodeURIComponent(c));
}
