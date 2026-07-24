import type { OAuth2Scheme } from '../../core/auth';

/**
 * Shared Google Docs (API v1) building blocks: the `/v1/documents` endpoints,
 * OAuth2 Bearer auth, the `documents.create` `{ title }` body, and the
 * `batchUpdate` `insertText` request. JSON throughout — no multipart.
 */

export const DOCS_API_BASE = 'https://docs.googleapis.com/v1/documents';

/** Docs authenticates with an OAuth2 bearer access token, attached by the transport. */
export const docsAuth: OAuth2Scheme = {
  type: 'oauth2',
  scopes: ['https://www.googleapis.com/auth/documents'],
};

/** A structural element within a document body (only the fields we read for text). */
interface StructuralElement {
  paragraph?: {
    elements?: Array<{ textRun?: { content?: string } }>;
  };
}

/** A Google document — trimmed to what reads use (the raw `body` is passed through). */
export interface GoogleDoc {
  documentId: string;
  title: string;
  body?: { content?: StructuralElement[] };
}

/**
 * Derive the plain text of a document from its body content — the useful shape
 * for a downstream step (email the contents, summarise, etc.). It reads only
 * Google's own `textRun.content` and adds nothing.
 */
export function docPlainText(doc: GoogleDoc): string {
  const parts: string[] = [];
  for (const element of doc.body?.content ?? []) {
    for (const run of element.paragraph?.elements ?? []) {
      if (typeof run.textRun?.content === 'string') parts.push(run.textRun.content);
    }
  }
  return parts.join('').replace(/\n+$/, '');
}
