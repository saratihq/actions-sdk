export { DOCS_API_BASE, docPlainText, docsAuth, type GoogleDoc } from './common';
export {
  APPEND_TEXT_TYPE,
  appendText,
  type AppendTextResult,
  CREATE_DOCUMENT_TYPE,
  createDocument,
  type CreatedDoc,
  READ_DOCUMENT_TYPE,
  readDocument,
} from './documents';

import { appendText, createDocument, readDocument } from './documents';

/** Every Google Docs action, for catalog builds and registration. */
export const docsActions = [createDocument, readDocument, appendText] as const;
