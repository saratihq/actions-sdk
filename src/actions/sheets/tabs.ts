import { defineAction } from '../../core/action';
import { shortText } from '../../core/props';
import { listSheetTabs, SHEETS_API_BASE, type SheetTab, sheetsAuth, spreadsheetIdProp } from './common';

/** Public action type ids — stable public catalog ids. */
export const LIST_SHEETS_TYPE = 'sheets.list_sheets';
export const CREATE_SPREADSHEET_TYPE = 'sheets.create_spreadsheet';

/** The create response (id, title and shareable URL of the new spreadsheet). */
export interface CreatedSpreadsheet {
  spreadsheetId: string;
  title: string;
  spreadsheetUrl?: string;
}

/** Create a new, empty spreadsheet with a title. */
export const createSpreadsheet = defineAction({
  type: CREATE_SPREADSHEET_TYPE,
  name: 'Create spreadsheet',
  description: 'Create a new Google spreadsheet with a title.',
  auth: sheetsAuth,
  props: {
    title: shortText<true>({ label: 'Title', required: true }),
  },
  async run({ auth, props, http }): Promise<CreatedSpreadsheet> {
    const res = await http.post<{
      spreadsheetId: string;
      properties?: { title?: string };
      spreadsheetUrl?: string;
    }>(SHEETS_API_BASE, { auth, body: { properties: { title: props.title } } });
    return {
      spreadsheetId: res.data.spreadsheetId,
      title: res.data.properties?.title ?? props.title,
      ...(res.data.spreadsheetUrl !== undefined ? { spreadsheetUrl: res.data.spreadsheetUrl } : {}),
    };
  },
});

/** List the worksheet tabs (name + id + index) of a spreadsheet — the tab names usable in a `range`. */
export const listSheets = defineAction({
  type: LIST_SHEETS_TYPE,
  name: 'List sheets',
  description: 'List the worksheet tabs of a Google spreadsheet.',
  auth: sheetsAuth,
  props: {
    spreadsheetId: spreadsheetIdProp(),
  },
  async run({ auth, props, http }): Promise<{ sheets: SheetTab[]; count: number }> {
    const sheets = await listSheetTabs(http, auth, props.spreadsheetId);
    return { sheets, count: sheets.length };
  },
});
