import { HttpClient } from '../../core/http/client';
import type { NormalizedRequest, NormalizedResponse } from '../../core/http/types';
import { FakeTransport, stubAuth } from '../../testing/fakes';
import { docPlainText } from './common';
import { appendText, createDocument, readDocument } from './documents';

/** Golden offline tests for the Google Docs actions, driven by a {@link FakeTransport}. */
function fake(handler: (req: NormalizedRequest, i: number) => NormalizedResponse) {
  const transport = new FakeTransport(handler);
  return { auth: stubAuth(transport, 'oauth2'), http: new HttpClient(), transport };
}

const DOC_BODY = {
  content: [
    { sectionBreak: {} },
    { paragraph: { elements: [{ textRun: { content: 'Hello ' } }, { textRun: { content: 'world\n' } }] } },
  ],
};

describe('docPlainText', () => {
  it('joins textRun content and trims the trailing newline', () => {
    expect(docPlainText({ documentId: 'd', title: 't', body: DOC_BODY })).toBe('Hello world');
    expect(docPlainText({ documentId: 'd', title: 't' })).toBe('');
  });
});

describe('docs.create_document', () => {
  it('POSTs the title and returns id + title', async () => {
    const { auth, http, transport } = fake(() => ({
      status: 200,
      headers: {},
      data: { documentId: 'doc1', title: 'Report' },
    }));
    const out = await createDocument.execute({ auth, http, props: { title: 'Report' } });
    expect(out).toEqual({ documentId: 'doc1', title: 'Report' });
    expect(transport.requests[0]!.url).toBe('https://docs.googleapis.com/v1/documents');
    expect(transport.requests[0]!.body).toEqual({ title: 'Report' });
  });
});

describe('docs.read_document', () => {
  it('GETs the document and returns derived plain text', async () => {
    const { auth, http, transport } = fake(() => ({
      status: 200,
      headers: {},
      data: { documentId: 'doc1', title: 'Report', body: DOC_BODY },
    }));
    const out = await readDocument.execute({ auth, http, props: { documentId: 'doc1' } });
    expect(out).toEqual({ documentId: 'doc1', title: 'Report', text: 'Hello world' });
    expect(transport.requests[0]!.url).toBe('https://docs.googleapis.com/v1/documents/doc1');
  });
});

describe('docs.append_text', () => {
  it('POSTs a batchUpdate insertText at the end of the document', async () => {
    const { auth, http, transport } = fake(() => ({
      status: 200,
      headers: {},
      data: { documentId: 'doc1' },
    }));
    await appendText.execute({ auth, http, props: { documentId: 'doc1', text: 'More.' } });
    const req = transport.requests[0]!;
    expect(req.url).toBe('https://docs.googleapis.com/v1/documents/doc1:batchUpdate');
    expect(req.body).toEqual({
      requests: [{ insertText: { endOfSegmentLocation: {}, text: 'More.' } }],
    });
  });
});
