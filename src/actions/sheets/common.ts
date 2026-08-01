import type { AuthHandle, OAuth2Scheme } from '../../core/auth';
import { ActionError } from '../../core/errors';
import type { HttpClient } from '../../core/http/client';
import type { JsonValue } from '../../core/http/types';
import { dropdown, type DropdownOption, type DropdownSchema, shortText } from '../../core/props';

export const SHEETS_API_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';

/** Drive is used only to LIST the user's spreadsheets for the picker. */
const DRIVE_FILES_URL = 'https://www.googleapis.com/drive/v3/files';
const SPREADSHEET_MIME = 'application/vnd.google-apps.spreadsheet';

/** OAuth2 bearer auth: `spreadsheets` covers value reads/writes, `drive.readonly` backs the spreadsheet picker. */
export const sheetsAuth: OAuth2Scheme = {
  type: 'oauth2',
  scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive.readonly'],
};

/** One worksheet (tab) within a spreadsheet, trimmed to what callers use. */
export interface SheetTab {
  sheetId: number;
  title: string;
  index: number;
}

/** A Drive file reference (id + name) — the picker's row shape. */
interface DriveFile {
  id: string;
  name: string;
}

/** Live spreadsheet picker over Drive; throws when the connection lacks Drive scope, and the host degrades the field to free text. */
export async function spreadsheetOptions(
  http: HttpClient,
  auth: AuthHandle,
  search?: string,
): Promise<DropdownOption<string>[]> {
  const nameClause = search ? ` and name contains '${escapeQ(search)}'` : '';
  const res = await http.get<{ files?: DriveFile[] }>(DRIVE_FILES_URL, {
    auth,
    query: {
      q: `mimeType='${SPREADSHEET_MIME}' and trashed=false${nameClause}`,
      pageSize: 100,
      orderBy: 'modifiedTime desc',
      fields: 'files(id,name)',
    },
  });
  return (res.data.files ?? []).map((file) => ({ label: file.name, value: file.id }));
}

/** Fetch a spreadsheet's worksheet tabs — shared by `list_sheets` and any tab lookup. */
export async function listSheetTabs(
  http: HttpClient,
  auth: AuthHandle,
  spreadsheetId: string,
): Promise<SheetTab[]> {
  const res = await http.get<{ sheets?: Array<{ properties?: SheetTab }> }>(
    `${SHEETS_API_BASE}/${encodeURIComponent(spreadsheetId)}`,
    { auth, query: { fields: 'sheets.properties' } },
  );
  return (res.data.sheets ?? []).map((s) => s.properties).filter((p): p is SheetTab => p !== undefined);
}

/** The required, live-picker `spreadsheetId` prop shared by every Sheets action. */
export function spreadsheetIdProp(): DropdownSchema<string, true> {
  return dropdown<string, true>({
    label: 'Spreadsheet',
    description: 'Loaded live from your Google Drive.',
    required: true,
    options: ({ auth, http, search }) => spreadsheetOptions(http, auth, search),
  });
}

/** The required A1-notation `range` prop (e.g. `Sheet1!A1:C10`, or a bare tab name). */
export function rangeProp(description: string) {
  return shortText<true>({ label: 'Range', description, required: true });
}

/** Build a `/spreadsheets/{id}/values/{range}` URL, encoding both segments. */
export function valuesUrl(spreadsheetId: string, range: string): string {
  return `${SHEETS_API_BASE}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`;
}

/** Coerce `values` into the 2-D array Sheets expects: a flat row is wrapped, rows pass through, a non-array throws `invalid_input`. */
export function toRows(values: JsonValue): JsonValue[][] {
  if (!Array.isArray(values)) {
    throw new ActionError({
      code: 'invalid_input',
      message: '"values" must be a row (array of cells) or an array of rows',
      retryable: false,
    });
  }
  if (values.length === 0) return [];
  if (values.every((row): row is JsonValue[] => Array.isArray(row))) return values;
  return [values];
}

/** Escape a single quote for embedding in a Drive `q` string literal. */
function escapeQ(value: string): string {
  return value.replace(/'/g, "\\'");
}
