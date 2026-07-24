export {
  ADD_IMAGE_TYPE,
  ADD_TEXT_TYPE,
  addImageToPdf,
  addTextToPdf,
  EXTRACT_PAGES_TYPE,
  EXTRACT_TEXT_TYPE,
  extractPdfPages,
  extractText,
  type ExtractTextResult,
  IMAGE_TO_PDF_TYPE,
  imageToPdf,
  MERGE_PDFS_TYPE,
  mergePdfs,
  PAGE_COUNT_TYPE,
  type PageCountResult,
  type PdfFileResult,
  pdfPageCount,
  TEXT_TO_PDF_TYPE,
  textToPdf,
} from './pdf';

import {
  addImageToPdf,
  addTextToPdf,
  extractPdfPages,
  extractText,
  imageToPdf,
  mergePdfs,
  pdfPageCount,
  textToPdf,
} from './pdf';

/** Every PDF action, for catalog builds and registration. */
export const pdfActions = [
  extractText,
  pdfPageCount,
  textToPdf,
  imageToPdf,
  mergePdfs,
  extractPdfPages,
  addTextToPdf,
  addImageToPdf,
] as const;
