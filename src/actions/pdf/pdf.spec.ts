import { PDFDocument } from 'pdf-lib';

import { FakeTransport, stubAuth } from '../../testing/fakes';
import {
  addImageToPdf,
  addTextToPdf,
  extractPdfPages,
  extractText,
  imageToPdf,
  mergePdfs,
  pdfActions,
  pdfPageCount,
  textToPdf,
} from './index';

const noAuth = stubAuth(new FakeTransport(() => ({ status: 200, headers: {}, data: {} })));

/** A 1×1 transparent PNG — enough for pdf-lib's embedPng to exercise the image path. */
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

/** Build a PDF with a known page count, as bytes. */
async function makePdf(pageCount: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pageCount; i++) doc.addPage([200, 200]);
  return Buffer.from(await doc.save());
}

async function pageCountOf(data: Buffer): Promise<number> {
  return (await PDFDocument.load(data)).getPageCount();
}

describe('pdf actions', () => {
  it('renders text to a PDF and round-trips it back through extraction', async () => {
    const created = await textToPdf.execute({ auth: noAuth, props: { text: 'Round Trip Extraction' } });
    expect(created.file.data.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    expect(created.mimetype).toBe('application/pdf');

    const extracted = await extractText.execute({ auth: noAuth, props: { file: created.file } });
    expect(extracted.text.replace(/\s+/g, '')).toContain('RoundTripExtraction');
  });

  it('counts the pages of a PDF', async () => {
    const out = await pdfPageCount.execute({
      auth: noAuth,
      props: { file: { filename: 'a.pdf', data: await makePdf(3) } },
    });
    expect(out.pageCount).toBe(3);
  });

  it('merges multiple PDFs into one', async () => {
    const out = await mergePdfs.execute({
      auth: noAuth,
      props: {
        files: [
          { file: { filename: 'a.pdf', data: await makePdf(2) } },
          { filename: 'b.pdf', data: await makePdf(3) },
        ],
      },
    });
    expect(await pageCountOf(out.file.data)).toBe(5);
    expect(out.name).toBe('merged-document.pdf');
  });

  it('rejects a merge of fewer than two files', async () => {
    await expect(
      mergePdfs.execute({ auth: noAuth, props: { files: [{ filename: 'a.pdf', data: await makePdf(2) }] } }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('extracts and reorders pages, honouring negative ranges', async () => {
    const data = await makePdf(5);
    const middle = await extractPdfPages.execute({
      auth: noAuth,
      props: { file: { filename: 'in.pdf', data }, pageRanges: [{ startPage: 2, endPage: 3 }] },
    });
    expect(await pageCountOf(middle.file.data)).toBe(2);

    const last = await extractPdfPages.execute({
      auth: noAuth,
      props: { file: { filename: 'in.pdf', data }, pageRanges: [{ startPage: -1, endPage: -1 }] },
    });
    expect(await pageCountOf(last.file.data)).toBe(1);
  });

  it('rejects an inverted page range', async () => {
    await expect(
      extractPdfPages.execute({
        auth: noAuth,
        props: {
          file: { filename: 'in.pdf', data: await makePdf(3) },
          pageRanges: [{ startPage: 3, endPage: 1 }],
        },
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('stamps text onto a PDF and the text is extractable', async () => {
    const out = await addTextToPdf.execute({
      auth: noAuth,
      props: {
        file: { filename: 'doc.pdf', data: await makePdf(1) },
        textItems: [
          {
            text: 'StampedHere',
            applyToAllPages: true,
            distanceFromLeft: 20,
            distanceFromTop: 20,
            fontSize: 14,
          },
        ],
      },
    });
    expect(await pageCountOf(out.file.data)).toBe(1);
    const extracted = await extractText.execute({ auth: noAuth, props: { file: out.file } });
    expect(extracted.text.replace(/\s+/g, '')).toContain('StampedHere');
  });

  it('converts an image into a single-page PDF', async () => {
    const out = await imageToPdf.execute({
      auth: noAuth,
      props: { image: { filename: 'pic.png', data: PNG_1x1 } },
    });
    expect(await pageCountOf(out.file.data)).toBe(1);
  });

  it('stamps an image onto an existing PDF', async () => {
    const out = await addImageToPdf.execute({
      auth: noAuth,
      props: {
        file: { filename: 'doc.pdf', data: await makePdf(1) },
        imageItems: [
          {
            image: { filename: 'pic.png', data: PNG_1x1 },
            applyToAllPages: true,
            distanceFromLeft: 10,
            distanceFromTop: 10,
            scale: 1,
          },
        ],
      },
    });
    expect(await pageCountOf(out.file.data)).toBe(1);
  });

  it('rejects a corrupt PDF with a clear error', async () => {
    await expect(
      pdfPageCount.execute({
        auth: noAuth,
        props: { file: { filename: 'bad.pdf', data: Buffer.from('not a pdf') } },
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('exposes eight actions, all pdf.* typed', () => {
    expect(pdfActions).toHaveLength(8);
    for (const action of pdfActions) expect(action.type.startsWith('pdf.')).toBe(true);
  });
});
