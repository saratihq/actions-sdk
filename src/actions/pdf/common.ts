import type { PDFPage } from 'pdf-lib';

import { ActionError } from '../../core/errors';

/** Shared helpers for the `pdf` actions (page targeting + rotation mapping). */

/** A file-ish value as it may arrive through a `json` array prop or a `file` prop. */
interface FileLike {
  data?: unknown;
  base64?: unknown;
}

/** Coerce a file payload into bytes — raw bytes, base64, or a JSON-serialised Buffer; throws `invalid_input` otherwise. */
export function toBytes(value: unknown, label = 'file'): Uint8Array {
  if (Buffer.isBuffer(value)) return new Uint8Array(value);
  if (value instanceof Uint8Array) return value;
  if (typeof value === 'string') return new Uint8Array(Buffer.from(value, 'base64'));
  if (typeof value === 'object' && value !== null) {
    const serialised = value as { type?: string; data?: unknown };
    if (serialised.type === 'Buffer' && Array.isArray(serialised.data)) {
      return new Uint8Array(Buffer.from(serialised.data as number[]));
    }
    const fileLike = value as FileLike;
    if (fileLike.data !== undefined) return toBytes(fileLike.data, label);
    if (typeof fileLike.base64 === 'string') return new Uint8Array(Buffer.from(fileLike.base64, 'base64'));
  }
  throw new ActionError({
    code: 'invalid_input',
    message: `${label} is not a readable file (expected bytes, a base64 string, or { filename, data })`,
    retryable: false,
  });
}

/** Resolve which pages a stamp applies to — all pages, or a single 1-indexed page. */
export function getTargetPages(
  pages: PDFPage[],
  applyToAllPages: boolean,
  pageNumber: number | undefined,
  itemName: string,
): PDFPage[] {
  if (applyToAllPages) return [...pages];
  if (pageNumber === undefined) {
    throw new ActionError({
      code: 'invalid_input',
      message: `Page Number is required when "Apply to all pages?" is off for ${itemName}.`,
      retryable: false,
    });
  }
  const index = Number(pageNumber) - 1;
  const page = pages[index];
  if (index < 0 || page === undefined) {
    throw new ActionError({
      code: 'invalid_input',
      message: `Requested page ${pageNumber} for ${itemName}, but the document has ${pages.length} page(s).`,
      retryable: false,
    });
  }
  return [page];
}

/** Map top-left visual coordinates to pdf-lib's bottom-left intrinsic space, honouring page rotation. */
export function mapVisualToIntrinsic(
  vX: number,
  anchorY: number,
  vWidth: number,
  vHeight: number,
  rotationAngle: number,
): { iX: number; iY: number; mappedRotation: number } {
  if (rotationAngle === 90) return { iX: vHeight - anchorY, iY: vX, mappedRotation: 90 };
  if (rotationAngle === 180) return { iX: vWidth - vX, iY: vHeight - anchorY, mappedRotation: 180 };
  if (rotationAngle === 270) return { iX: anchorY, iY: vWidth - vX, mappedRotation: -90 };
  return { iX: vX, iY: anchorY, mappedRotation: 0 };
}

/** Normalise a pdf-lib page rotation to the 0/90/180/270 bucket. */
export function normalizedRotation(angle: number): number {
  return ((angle % 360) + 360) % 360;
}
