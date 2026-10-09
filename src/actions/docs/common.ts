import type { OAuth2Scheme } from '../../core/auth';

/** Shared Google Docs (API v1) building blocks: `/v1/documents`, OAuth2 bearer auth, and `batchUpdate`. */

export const DOCS_API_BASE = 'https://docs.googleapis.com/v1/documents';

/** Docs authenticates with an OAuth2 bearer access token, attached by the transport. */
export const docsAuth: OAuth2Scheme = {
  type: 'oauth2',
  origins: ['https://docs.googleapis.com'],
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

/** Derive a document's plain text from its body content, reading only Google's own `textRun.content`. */
export function docPlainText(doc: GoogleDoc): string {
  const parts: string[] = [];
  for (const element of doc.body?.content ?? []) {
    for (const run of element.paragraph?.elements ?? []) {
      if (typeof run.textRun?.content === 'string') parts.push(run.textRun.content);
    }
  }
  return parts.join('').replace(/\n+$/, '');
}
