import { defineAction } from '../../core/action';
import type { JsonValue } from '../../core/http/types';
import { dropdown, json } from '../../core/props';
import { rangeProp, sheetsAuth, spreadsheetIdProp, toRows, valuesUrl } from './common';

/** Public action type ids — stable public catalog ids. */
export const READ_RANGE_TYPE = 'sheets.read_range';
export const INSERT_ROW_TYPE = 'sheets.insert_row';
export const UPDATE_ROW_TYPE = 'sheets.update_row';
export const CLEAR_SHEET_TYPE = 'sheets.clear_sheet';

/** A read value-range: the resolved A1 `range` and its cell `values` (rows of cells). */
export interface ValueRange {
  range: string;
  majorDimension?: string;
  values?: JsonValue[][];
}

/** The append response's `updates` block — what changed and where. */
export interface AppendResult {
  spreadsheetId: string;
  updatedRange: string;
  updatedRows: number;
  updatedColumns: number;
  updatedCells: number;
}

/** Read the cell values in a range (A1 notation). Read-only. */
export const readRange = defineAction({
  type: READ_RANGE_TYPE,
  name: 'Read rows',
  description: 'Read the cell values in a range of a Google Sheet.',
  auth: sheetsAuth,
  props: {
    spreadsheetId: spreadsheetIdProp(),
    range: rangeProp('The A1 range to read, e.g. Sheet1!A1:C10 or a whole tab: Sheet1.'),
  },
  async run({ auth, props, http }): Promise<ValueRange> {
    const res = await http.get<ValueRange>(valuesUrl(props.spreadsheetId, props.range), { auth });
    return res.data;
  },
});

/** Append row(s) to the end of a range's data; `USER_ENTERED` lets Sheets parse values the way the UI would. */
export const insertRow = defineAction({
  type: INSERT_ROW_TYPE,
  name: 'Add row',
  description: 'Append a row (or rows) to a Google Sheet.',
  auth: sheetsAuth,
  props: {
    spreadsheetId: spreadsheetIdProp(),
    range: rangeProp('The tab (or range) to append to, e.g. Sheet1.'),
    values: json<true>({
      label: 'Values',
      description: 'A row (array of cells), or an array of rows.',
      required: true,
    }),
  },
  async run({ auth, props, http }): Promise<AppendResult> {
    const res = await http.post<{ updates: AppendResult }>(
      `${valuesUrl(props.spreadsheetId, props.range)}:append`,
      {
        auth,
        query: { valueInputOption: 'USER_ENTERED', insertDataOption: 'INSERT_ROWS' },
        body: { values: toRows(props.values) },
      },
    );
    return res.data.updates;
  },
});

/** The update response — cells written and the affected range. */
export interface UpdateResult {
  spreadsheetId: string;
  updatedRange: string;
  updatedRows: number;
  updatedColumns: number;
  updatedCells: number;
}

/** Overwrite the cell values in a range with the supplied row(s). */
export const updateRow = defineAction({
  type: UPDATE_ROW_TYPE,
  name: 'Update row',
  description: 'Overwrite the cell values in a range of a Google Sheet.',
  auth: sheetsAuth,
  props: {
    spreadsheetId: spreadsheetIdProp(),
    range: rangeProp('The A1 range to overwrite, e.g. Sheet1!A2:C2.'),
    values: json<true>({
      label: 'Values',
      description: 'A row (array of cells), or an array of rows.',
      required: true,
    }),
    valueInputOption: dropdown<string, false>({
      label: 'Value input option',
      required: false,
      defaultValue: 'USER_ENTERED',
      options: [
        { label: 'User entered (parse like the UI)', value: 'USER_ENTERED' },
        { label: 'Raw (store verbatim)', value: 'RAW' },
      ],
    }),
  },
  async run({ auth, props, http }): Promise<UpdateResult> {
    const res = await http.put<UpdateResult>(valuesUrl(props.spreadsheetId, props.range), {
      auth,
      query: { valueInputOption: props.valueInputOption ?? 'USER_ENTERED' },
      body: { values: toRows(props.values) },
    });
    return res.data;
  },
});

/** The clear response — the range that was cleared. */
export interface ClearResult {
  spreadsheetId: string;
  clearedRange: string;
}

/** Clear the cell values in a range (leaves formatting intact). */
export const clearSheet = defineAction({
  type: CLEAR_SHEET_TYPE,
  name: 'Clear range',
  description: 'Clear the cell values in a range of a Google Sheet.',
  auth: sheetsAuth,
  props: {
    spreadsheetId: spreadsheetIdProp(),
    range: rangeProp('The A1 range to clear, e.g. Sheet1!A1:C10 or a whole tab: Sheet1.'),
  },
  async run({ auth, props, http }): Promise<ClearResult> {
    const res = await http.post<ClearResult>(`${valuesUrl(props.spreadsheetId, props.range)}:clear`, {
      auth,
      body: {},
    });
    return res.data;
  },
});
