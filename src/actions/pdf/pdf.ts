import { degrees, PageSizes, PDFDocument, rgb, StandardFonts } from 'pdf-lib';

import { defineAction } from '../../core/action';
import { ActionError } from '../../core/errors';
import type { JsonValue } from '../../core/http/types';
import { file, type FileInput, json, longText, shortText } from '../../core/props';
import { getTargetPages, mapVisualToIntrinsic, normalizedRotation, toBytes } from './common';

/**
 * PDF utilities — no-auth (`none` scheme) actions. Generation/merge/page-ops
 * are backed by `pdf-lib` (MIT); text extraction by `unpdf` (MIT, a maintained
 * pdf.js build). Action names are snake_case for the SDK namespace (which forbids
 * uppercase), so camelCase forms (`extractText`, `textToPdf`, …) are re-spelled.
 */

/** A file an action produces, in the SDK's file-output shape (see `slack.get_file`). */
export interface PdfFileResult {
  file: FileInput;
  name: string;
  mimetype: string;
  size: number;
}

const PDF_MIME = 'application/pdf';

function pdfResult(bytes: Uint8Array, filename: string): PdfFileResult {
  const data = Buffer.from(bytes);
  const name = filename.toLowerCase().endsWith('.pdf') ? filename : `${filename}.pdf`;
  return {
    file: { filename: name, data, mimeType: PDF_MIME },
    name,
    mimetype: PDF_MIME,
    size: data.byteLength,
  };
}

// ─── ESM interop for unpdf (the package is ESM-only) ───

interface UnpdfModule {
  getDocumentProxy(data: Uint8Array): Promise<unknown>;
  extractText(pdf: unknown, options: { mergePages: boolean }): Promise<{ text: string; totalPages: number }>;
}
/**
 * A real dynamic `import()` that TypeScript will not down-level to `require()`
 * under `module: commonjs` — the only way a CJS build can load the ESM-only
 * `unpdf`. The Jest suite enables it via `--experimental-vm-modules`.
 */
// eslint-disable-next-line @typescript-eslint/no-implied-eval -- the only way a CJS build can load the ESM-only `unpdf`; TS must not down-level this import().
const importEsm = new Function('specifier', 'return import(specifier)') as (s: string) => Promise<unknown>;

export const EXTRACT_TEXT_TYPE = 'pdf.extract_text';
export interface ExtractTextResult {
  text: string;
}
export const extractText = defineAction({
  type: EXTRACT_TEXT_TYPE,
  name: 'Extract Text',
  description: 'Extract the text content from a PDF file.',
  auth: { type: 'none' },
  props: {
    file: file({ label: 'PDF File', required: true }),
  },
  run: async ({ props }): Promise<ExtractTextResult> => {
    try {
      const unpdf = (await importEsm('unpdf')) as UnpdfModule;
      const pdf = await unpdf.getDocumentProxy(toBytes(props.file.data, 'PDF File'));
      const { text } = await unpdf.extractText(pdf, { mergePages: true });
      return { text };
    } catch (err) {
      throw new ActionError({
        code: 'invalid_input',
        message: `Failed to extract text: ${err instanceof Error ? err.message : String(err)}`,
        retryable: false,
      });
    }
  },
});

export const PAGE_COUNT_TYPE = 'pdf.pdf_page_count';
export interface PageCountResult {
  pageCount: number;
}
export const pdfPageCount = defineAction({
  type: PAGE_COUNT_TYPE,
  name: 'PDF Page Count',
  description: 'Get the number of pages in a PDF file.',
  auth: { type: 'none' },
  props: {
    file: file({ label: 'PDF File', required: true }),
  },
  run: async ({ props }): Promise<PageCountResult> => {
    try {
      const doc = await PDFDocument.load(toBytes(props.file.data, 'PDF File'));
      return { pageCount: doc.getPageCount() };
    } catch (err) {
      throw new ActionError({
        code: 'invalid_input',
        message: `Failed to read PDF: ${err instanceof Error ? err.message : String(err)}`,
        retryable: false,
      });
    }
  },
});

export const TEXT_TO_PDF_TYPE = 'pdf.text_to_pdf';
export const textToPdf = defineAction({
  type: TEXT_TO_PDF_TYPE,
  name: 'Text to PDF',
  description: 'Render plain text into an A4 PDF, wrapping lines to fit the page.',
  auth: { type: 'none' },
  props: {
    text: longText({ label: 'Text', required: true }),
  },
  run: async ({ props }): Promise<PdfFileResult> => {
    const [pageWidth, pageHeight] = PageSizes.A4;
    const margin = 50;
    const topMargin = 70;
    const fontSize = 12;
    const lineSpacing = 5;
    const paragraphSpacing = 8;
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const lineHeight = font.heightAtSize(fontSize) + lineSpacing;
    const maxWidth = pageWidth - margin * 2;
    let page = doc.addPage([pageWidth, pageHeight]);
    let y = pageHeight - topMargin;
    const advance = (): void => {
      y -= lineHeight;
      if (y < margin + lineHeight) {
        page = doc.addPage([pageWidth, pageHeight]);
        y = pageHeight - topMargin;
      }
    };
    for (const paragraph of props.text.split('\n')) {
      let line = '';
      for (const word of paragraph.split(' ')) {
        const candidate = `${line}${word} `;
        if (font.widthOfTextAtSize(candidate, fontSize) > maxWidth && line !== '') {
          page.drawText(line.trimEnd(), { x: margin, y, size: fontSize, font });
          line = `${word} `;
          advance();
        } else {
          line = candidate;
        }
      }
      if (line.trim() !== '') {
        page.drawText(line.trimEnd(), { x: margin, y, size: fontSize, font });
        advance();
      }
      y -= paragraphSpacing;
    }
    return pdfResult(await doc.save(), 'text.pdf');
  },
});

export const IMAGE_TO_PDF_TYPE = 'pdf.image_to_pdf';
export const imageToPdf = defineAction({
  type: IMAGE_TO_PDF_TYPE,
  name: 'Image to PDF',
  description: 'Place a PNG/JPEG image onto an A4 PDF page, scaled to fit.',
  auth: { type: 'none' },
  props: {
    image: file({ label: 'Image', description: 'A PNG or JPEG image.', required: true }),
  },
  run: async ({ props }): Promise<PdfFileResult> => {
    const bytes = toBytes(props.image.data, 'Image');
    const doc = await PDFDocument.create();
    const [pageWidth, pageHeight] = PageSizes.A4;
    const page = doc.addPage([pageWidth, pageHeight]);
    const ext = (props.image.filename.split('.').pop() ?? '').toLowerCase();
    const mime = (props.image.mimeType ?? '').toLowerCase();
    let embedded;
    if (ext === 'png' || mime.includes('png')) {
      embedded = await doc.embedPng(bytes);
    } else if (ext === 'jpg' || ext === 'jpeg' || mime.includes('jpeg') || mime.includes('jpg')) {
      embedded = await doc.embedJpg(bytes);
    } else {
      throw new ActionError({
        code: 'invalid_input',
        message: `Unsupported image format "${ext || mime || 'unknown'}" — expected PNG or JPEG.`,
        retryable: false,
      });
    }
    const margin = 30;
    const scaled = embedded.scaleToFit(pageWidth - margin * 2, pageHeight - margin * 2);
    page.drawImage(embedded, {
      x: (pageWidth - scaled.width) / 2,
      y: (pageHeight - scaled.height) / 2,
      width: scaled.width,
      height: scaled.height,
    });
    return pdfResult(await doc.save(), `${props.image.filename}.pdf`);
  },
});

export const MERGE_PDFS_TYPE = 'pdf.merge_pdfs';
export const mergePdfs = defineAction({
  type: MERGE_PDFS_TYPE,
  name: 'Merge PDFs',
  description: 'Merge multiple PDF files into a single PDF document.',
  auth: { type: 'none' },
  props: {
    files: json({
      label: 'PDF Files',
      description: 'A JSON array of PDF files (or { file } wrappers) to merge, in order.',
      required: true,
    }),
    outputFileName: shortText({
      label: 'Output File Name',
      required: false,
      defaultValue: 'merged-document',
    }),
  },
  run: async ({ props }): Promise<PdfFileResult> => {
    if (!Array.isArray(props.files) || props.files.length < 2) {
      throw new ActionError({
        code: 'invalid_input',
        message: 'At least 2 PDF files are required for merging.',
        retryable: false,
      });
    }
    const merged = await PDFDocument.create();
    for (let i = 0; i < props.files.length; i++) {
      const entry = props.files[i] as JsonValue;
      const source =
        entry !== null && typeof entry === 'object' && !Array.isArray(entry) && 'file' in entry
          ? (entry as { file: unknown }).file
          : entry;
      try {
        const doc = await PDFDocument.load(toBytes(source, `PDF file ${i + 1}`));
        const copied = await merged.copyPages(doc, doc.getPageIndices());
        for (const page of copied) merged.addPage(page);
      } catch (err) {
        if (err instanceof ActionError) throw err;
        throw new ActionError({
          code: 'invalid_input',
          message: `Failed to read PDF file ${i + 1}: ${err instanceof Error ? err.message : String(err)}`,
          retryable: false,
        });
      }
    }
    const name =
      props.outputFileName && props.outputFileName.length > 0 ? props.outputFileName : 'merged-document';
    return pdfResult(await merged.save(), name);
  },
});

interface PageRange {
  startPage: number;
  endPage: number;
}
/** Expand one inclusive, 1-indexed range (negatives count from the end) to page indices. */
function rangeToIndexes(range: PageRange, totalPages: number): number[] {
  const { startPage, endPage } = range;
  if (startPage === 0 || endPage === 0) throw rangeError('Range start/end must be a non-zero number.');
  if (Math.abs(startPage) > totalPages || Math.abs(endPage) > totalPages) {
    throw rangeError('Range start/end must be within the total number of pages.');
  }
  const start = startPage < 0 ? totalPages + startPage : startPage - 1;
  const end = endPage < 0 ? totalPages + endPage : endPage - 1;
  if (start > end) throw rangeError(`Range start (${startPage}) must be less than end (${endPage}).`);
  return Array.from({ length: end - start + 1 }, (_, idx) => start + idx);
}
function rangeError(message: string): ActionError {
  return new ActionError({ code: 'invalid_input', message, retryable: false });
}
function asPageRanges(value: JsonValue): PageRange[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw rangeError('"pageRanges" must be a non-empty JSON array of { startPage, endPage }.');
  }
  return value.map((raw) => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw rangeError('Each page range must be an object { startPage, endPage }.');
    }
    const start = Number((raw as Record<string, unknown>).startPage);
    const end = Number((raw as Record<string, unknown>).endPage);
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      throw rangeError('startPage and endPage must be numbers.');
    }
    return { startPage: start, endPage: end };
  });
}

export const EXTRACT_PAGES_TYPE = 'pdf.extract_pdf_pages';
export const extractPdfPages = defineAction({
  type: EXTRACT_PAGES_TYPE,
  name: 'Extract PDF Pages',
  description: 'Extract or reorder pages from a PDF into a new document.',
  auth: { type: 'none' },
  props: {
    file: file({ label: 'PDF File', required: true }),
    pageRanges: json({
      label: 'Page Ranges',
      description: 'A JSON array of { startPage, endPage } (1-indexed; negatives count from the end).',
      required: true,
    }),
  },
  run: async ({ props }): Promise<PdfFileResult> => {
    const src = await PDFDocument.load(toBytes(props.file.data, 'PDF File'));
    const total = src.getPageCount();
    const indexes = asPageRanges(props.pageRanges).flatMap((range) => rangeToIndexes(range, total));
    const out = await PDFDocument.create();
    const copied = await out.copyPages(src, indexes);
    for (const page of copied) out.addPage(page);
    return pdfResult(await out.save(), props.file.filename);
  },
});

interface TextItem {
  text: string;
  applyToAllPages: boolean;
  pageNumber?: number;
  distanceFromLeft: number;
  distanceFromTop: number;
  font: string;
  fontSize: number;
  lineSpacing: number;
}
function asTextItems(value: JsonValue): TextItem[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw rangeError('"textItems" must be a non-empty JSON array.');
  }
  return value.map((raw) => {
    const rec = raw as Record<string, unknown>;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw) || typeof rec.text !== 'string') {
      throw rangeError('Each text item needs at least a "text" string.');
    }
    return {
      text: rec.text,
      applyToAllPages: rec.applyToAllPages === true,
      ...(rec.pageNumber !== undefined ? { pageNumber: Number(rec.pageNumber) } : {}),
      distanceFromLeft: Number(rec.distanceFromLeft ?? 0),
      distanceFromTop: Number(rec.distanceFromTop ?? 0),
      font: typeof rec.font === 'string' ? rec.font : StandardFonts.Helvetica,
      fontSize: Number(rec.fontSize ?? 11),
      lineSpacing: Number(rec.lineSpacing ?? 1.15),
    };
  });
}

export const ADD_TEXT_TYPE = 'pdf.add_text_to_pdf';
export const addTextToPdf = defineAction({
  type: ADD_TEXT_TYPE,
  name: 'Add Text to PDF',
  description: 'Stamp text onto pages of an existing PDF at a given position.',
  auth: { type: 'none' },
  props: {
    file: file({ label: 'PDF File', required: true }),
    textItems: json({
      label: 'Text Items to Insert',
      description:
        'A JSON array of { text, applyToAllPages, pageNumber, distanceFromLeft, distanceFromTop, font, fontSize, lineSpacing }.',
      required: true,
    }),
  },
  run: async ({ props }): Promise<PdfFileResult> => {
    const doc = await PDFDocument.load(toBytes(props.file.data, 'PDF File'));
    const pages = doc.getPages();
    const fontCache = new Map<string, Awaited<ReturnType<typeof doc.embedFont>>>();
    for (const item of asTextItems(props.textItems)) {
      if (item.fontSize <= 0) throw rangeError(`Font Size must be greater than 0 (got ${item.fontSize}).`);
      if (item.lineSpacing <= 0)
        throw rangeError(`Line Spacing must be greater than 0 (got ${item.lineSpacing}).`);
      const cleanText = item.text.replace(/\r\n|\r/g, '\n');
      let embedded = fontCache.get(item.font);
      if (!embedded) {
        embedded = await doc.embedFont(item.font);
        fontCache.set(item.font, embedded);
      }
      const lineHeight = item.fontSize * item.lineSpacing;
      for (const page of getTargetPages(pages, item.applyToAllPages, item.pageNumber, 'a text item')) {
        const { width, height } = page.getSize();
        const rotation = normalizedRotation(page.getRotation().angle ?? 0);
        const landscape = rotation === 90 || rotation === 270;
        const vWidth = landscape ? height : width;
        const vHeight = landscape ? width : height;
        const anchorY = vHeight - item.distanceFromTop;
        const { iX, iY, mappedRotation } = mapVisualToIntrinsic(
          item.distanceFromLeft,
          anchorY,
          vWidth,
          vHeight,
          rotation,
        );
        page.drawText(cleanText, {
          x: iX,
          y: iY,
          size: item.fontSize,
          font: embedded,
          color: rgb(0, 0, 0),
          lineHeight,
          rotate: degrees(mappedRotation),
        });
      }
    }
    return pdfResult(await doc.save(), `text_stamped_${props.file.filename}`);
  },
});

interface ImageItem {
  imageData: unknown;
  extension: string;
  applyToAllPages: boolean;
  pageNumber?: number;
  distanceFromLeft: number;
  distanceFromTop: number;
  scale: number;
}
function asImageItems(value: JsonValue): ImageItem[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw rangeError('"imageItems" must be a non-empty JSON array.');
  }
  return value.map((raw) => {
    const rec = raw as Record<string, unknown>;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw rangeError('Each image item must be an object.');
    }
    const image = (rec.image ?? rec.imageFile) as { data?: unknown; filename?: unknown; mimeType?: unknown };
    const filename = typeof image?.filename === 'string' ? image.filename : '';
    const declared = typeof rec.extension === 'string' ? rec.extension : '';
    const extension = ((filename.split('.').pop() ?? '') || declared).toLowerCase();
    return {
      imageData: image?.data ?? rec.data,
      extension,
      applyToAllPages: rec.applyToAllPages === true,
      ...(rec.pageNumber !== undefined ? { pageNumber: Number(rec.pageNumber) } : {}),
      distanceFromLeft: Number(rec.distanceFromLeft ?? 0),
      distanceFromTop: Number(rec.distanceFromTop ?? 0),
      scale: Number(rec.scale ?? 1),
    };
  });
}

export const ADD_IMAGE_TYPE = 'pdf.add_image_to_pdf';
export const addImageToPdf = defineAction({
  type: ADD_IMAGE_TYPE,
  name: 'Add Image to PDF',
  description: 'Stamp a PNG/JPEG image onto pages of an existing PDF at a given position.',
  auth: { type: 'none' },
  props: {
    file: file({ label: 'PDF File', required: true }),
    imageItems: json({
      label: 'Image Items to Insert',
      description:
        'A JSON array of { image: { filename, data }, applyToAllPages, pageNumber, distanceFromLeft, distanceFromTop, scale }.',
      required: true,
    }),
  },
  run: async ({ props }): Promise<PdfFileResult> => {
    const doc = await PDFDocument.load(toBytes(props.file.data, 'PDF File'));
    const pages = doc.getPages();
    let index = 0;
    for (const item of asImageItems(props.imageItems)) {
      index += 1;
      if (item.scale <= 0)
        throw rangeError(`Image Scale must be greater than 0 (got ${item.scale}) for item ${index}.`);
      const bytes = toBytes(item.imageData, `image item ${index}`);
      let embedded;
      if (item.extension === 'png') {
        embedded = await doc.embedPng(bytes);
      } else if (item.extension === 'jpg' || item.extension === 'jpeg') {
        embedded = await doc.embedJpg(bytes);
      } else {
        throw rangeError(
          `Unsupported image format "${item.extension || 'unknown'}" for item ${index} (PNG/JPEG only).`,
        );
      }
      const dims = embedded.scale(item.scale);
      for (const page of getTargetPages(
        pages,
        item.applyToAllPages,
        item.pageNumber,
        `image item ${index}`,
      )) {
        const { width, height } = page.getSize();
        const rotation = normalizedRotation(page.getRotation().angle ?? 0);
        const landscape = rotation === 90 || rotation === 270;
        const vWidth = landscape ? height : width;
        const vHeight = landscape ? width : height;
        const anchorY = vHeight - item.distanceFromTop - dims.height;
        const { iX, iY, mappedRotation } = mapVisualToIntrinsic(
          item.distanceFromLeft,
          anchorY,
          vWidth,
          vHeight,
          rotation,
        );
        page.drawImage(embedded, {
          x: iX,
          y: iY,
          width: dims.width,
          height: dims.height,
          rotate: degrees(mappedRotation),
        });
      }
    }
    return pdfResult(await doc.save(), `image_stamped_${props.file.filename}`);
  },
});
