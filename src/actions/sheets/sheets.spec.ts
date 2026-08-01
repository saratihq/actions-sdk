import { HttpClient } from '../../core/http/client';
import type { NormalizedRequest, NormalizedResponse } from '../../core/http/types';
import { FakeTransport, stubAuth } from '../../testing/fakes';
import { toRows } from './common';
import { listSheets } from './tabs';
import { clearSheet, insertRow, readRange, updateRow } from './values';

function fake(handler: (req: NormalizedRequest, i: number) => NormalizedResponse) {
  const transport = new FakeTransport(handler);
  return { auth: stubAuth(transport, 'oauth2'), http: new HttpClient(), transport };
}

const SS = 'ssABC';

describe('toRows', () => {
  it('wraps a flat row and passes an array of rows through', () => {
    expect(toRows(['Ada', 99])).toEqual([['Ada', 99]]);
    expect(
      toRows([
        ['a', 'b'],
        ['c', 'd'],
      ]),
    ).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
    expect(toRows([])).toEqual([]);
  });

  it('rejects a non-array as invalid input', async () => {
    const { auth, http } = fake(() => ({ status: 200, headers: {}, data: {} }));
    await expect(
      insertRow.execute({ auth, http, props: { spreadsheetId: SS, range: 'Sheet1', values: 'nope' } }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });
});

describe('sheets.read_range', () => {
  it('GETs the values in a range', async () => {
    const { auth, http, transport } = fake(() => ({
      status: 200,
      headers: {},
      data: { range: 'Sheet1!A1:B2', majorDimension: 'ROWS', values: [['Name', 'Score']] },
    }));
    const out = await readRange.execute({ auth, http, props: { spreadsheetId: SS, range: 'Sheet1!A1:B2' } });
    expect(out.values).toEqual([['Name', 'Score']]);
    expect(transport.requests[0]!.method).toBe('GET');
    expect(transport.requests[0]!.url).toBe(
      'https://sheets.googleapis.com/v4/spreadsheets/ssABC/values/Sheet1!A1%3AB2',
    );
  });
});

describe('sheets.insert_row (append)', () => {
  it('POSTs :append with USER_ENTERED and returns the updates block', async () => {
    const { auth, http, transport } = fake(() => ({
      status: 200,
      headers: {},
      data: {
        updates: {
          spreadsheetId: SS,
          updatedRange: 'Sheet1!A1:B1',
          updatedRows: 1,
          updatedColumns: 2,
          updatedCells: 2,
        },
      },
    }));
    const out = await insertRow.execute({
      auth,
      http,
      props: { spreadsheetId: SS, range: 'Sheet1', values: ['Ada', 99] },
    });
    expect(out.updatedCells).toBe(2);
    const req = transport.requests[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toContain('/values/Sheet1:append');
    expect(req.url).toContain('valueInputOption=USER_ENTERED');
    expect(req.body).toEqual({ values: [['Ada', 99]] });
  });
});

describe('sheets.update_row', () => {
  it('PUTs the range with the supplied rows', async () => {
    const { auth, http, transport } = fake(() => ({
      status: 200,
      headers: {},
      data: {
        spreadsheetId: SS,
        updatedRange: 'Sheet1!A2:B2',
        updatedRows: 1,
        updatedColumns: 2,
        updatedCells: 2,
      },
    }));
    await updateRow.execute({
      auth,
      http,
      props: { spreadsheetId: SS, range: 'Sheet1!A2:B2', values: ['Grace', 100] },
    });
    const req = transport.requests[0]!;
    expect(req.method).toBe('PUT');
    expect(req.url).toContain('/values/Sheet1!A2%3AB2');
    expect(req.body).toEqual({ values: [['Grace', 100]] });
  });
});

describe('sheets.clear_sheet', () => {
  it('POSTs :clear with an empty body', async () => {
    const { auth, http, transport } = fake(() => ({
      status: 200,
      headers: {},
      data: { spreadsheetId: SS, clearedRange: 'Sheet1!A1:Z1000' },
    }));
    const out = await clearSheet.execute({ auth, http, props: { spreadsheetId: SS, range: 'Sheet1' } });
    expect(out.clearedRange).toBe('Sheet1!A1:Z1000');
    expect(transport.requests[0]!.url).toContain('/values/Sheet1:clear');
    expect(transport.requests[0]!.body).toEqual({});
  });
});

describe('sheets.list_sheets + spreadsheet picker', () => {
  it('lists worksheet tabs from the properties field', async () => {
    const { auth, http, transport } = fake(() => ({
      status: 200,
      headers: {},
      data: { sheets: [{ properties: { sheetId: 0, title: 'Sheet1', index: 0 } }] },
    }));
    const out = await listSheets.execute({ auth, http, props: { spreadsheetId: SS } });
    expect(out.count).toBe(1);
    expect(out.sheets[0]).toEqual({ sheetId: 0, title: 'Sheet1', index: 0 });
    expect(transport.requests[0]!.url).toContain('fields=sheets.properties');
  });

  it('the spreadsheet picker lists Drive spreadsheets and maps name→id', async () => {
    const { auth, http, transport } = fake(() => ({
      status: 200,
      headers: {},
      data: { files: [{ id: 'ssABC', name: 'Budget' }] },
    }));
    const picker = await readRange.loadOptions('spreadsheetId', { auth, http });
    expect(picker.disabled).toBe(false);
    expect(picker.options[0]).toEqual({ label: 'Budget', value: 'ssABC' });
    // The picker reads Drive (independent of any other prop), scoped to spreadsheets.
    expect(transport.requests[0]!.url).toContain('googleapis.com/drive/v3/files');
    expect(decodeURIComponent(transport.requests[0]!.url)).toContain(
      "mimeType='application/vnd.google-apps.spreadsheet'",
    );
  });

  it('the spreadsheet picker is inert without a connection', async () => {
    const result = await readRange.loadOptions('spreadsheetId', {});
    expect(result.disabled).toBe(true);
  });
});
