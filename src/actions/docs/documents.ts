import { defineAction } from '../../core/action';
import { longText, shortText } from '../../core/props';
import { DOCS_API_BASE, docPlainText, docsAuth, type GoogleDoc } from './common';

/** Public action type ids — aligned to the established catalog ids. */
export const CREATE_DOCUMENT_TYPE = 'docs.create_document';
export const READ_DOCUMENT_TYPE = 'docs.read_document';
export const APPEND_TEXT_TYPE = 'docs.append_text';

/** The create response (id + title of the new, empty document). */
export interface CreatedDoc {
  documentId: string;
  title: string;
}

/** Create a new, empty document with a title. */
export const createDocument = defineAction({
  type: CREATE_DOCUMENT_TYPE,
  name: 'Create document',
  description: 'Create a new Google Doc with a title.',
  auth: docsAuth,
  props: {
    title: shortText<true>({ label: 'Title', required: true }),
  },
  async run({ auth, props, http }): Promise<CreatedDoc> {
    const res = await http.post<GoogleDoc>(DOCS_API_BASE, { auth, body: { title: props.title } });
    return { documentId: res.data.documentId, title: res.data.title };
  },
});

/** Read a document — returns its id, title and derived plain text. */
export const readDocument = defineAction({
  type: READ_DOCUMENT_TYPE,
  name: 'Read document',
  description: 'Read a Google Doc and return its plain text.',
  auth: docsAuth,
  props: {
    documentId: shortText<true>({ label: 'Document id', required: true }),
  },
  async run({ auth, props, http }): Promise<{ documentId: string; title: string; text: string }> {
    const res = await http.get<GoogleDoc>(`${DOCS_API_BASE}/${encodeURIComponent(props.documentId)}`, {
      auth,
    });
    return { documentId: res.data.documentId, title: res.data.title, text: docPlainText(res.data) };
  },
});

/** The batchUpdate response (id of the document that was edited). */
export interface AppendTextResult {
  documentId: string;
}

/**
 * Append text to the end of a document. Uses a single `insertText` request at the
 * document's end-of-segment location, so the caller never computes an index.
 */
export const appendText = defineAction({
  type: APPEND_TEXT_TYPE,
  name: 'Append text',
  description: 'Append text to the end of a Google Doc.',
  auth: docsAuth,
  props: {
    documentId: shortText<true>({ label: 'Document id', required: true }),
    text: longText<true>({ label: 'Text', required: true }),
  },
  async run({ auth, props, http }): Promise<AppendTextResult> {
    const res = await http.post<AppendTextResult>(
      `${DOCS_API_BASE}/${encodeURIComponent(props.documentId)}:batchUpdate`,
      {
        auth,
        body: { requests: [{ insertText: { endOfSegmentLocation: {}, text: props.text } }] },
      },
    );
    return { documentId: res.data.documentId };
  },
});
