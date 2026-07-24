export {
  rangeProp,
  SHEETS_API_BASE,
  type SheetTab,
  sheetsAuth,
  spreadsheetIdProp,
  spreadsheetOptions,
  listSheetTabs,
  toRows,
  valuesUrl,
} from './common';
export {
  type AppendResult,
  CLEAR_SHEET_TYPE,
  clearSheet,
  type ClearResult,
  INSERT_ROW_TYPE,
  insertRow,
  READ_RANGE_TYPE,
  readRange,
  UPDATE_ROW_TYPE,
  updateRow,
  type UpdateResult,
  type ValueRange,
} from './values';
export {
  CREATE_SPREADSHEET_TYPE,
  createSpreadsheet,
  type CreatedSpreadsheet,
  LIST_SHEETS_TYPE,
  listSheets,
} from './tabs';

export { SHEETS_NEW_ROW_TYPE, newRow, type SheetRowEvent } from './new-row.polling';

import { createSpreadsheet, listSheets } from './tabs';
import { clearSheet, insertRow, readRange, updateRow } from './values';

/** Every Google Sheets action, for catalog builds and registration. */
export const sheetsActions = [
  createSpreadsheet,
  readRange,
  insertRow,
  updateRow,
  clearSheet,
  listSheets,
] as const;
