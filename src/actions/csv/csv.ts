import { Workbook } from 'exceljs';

import { defineAction } from '../../core/action';
import { ActionError } from '../../core/errors';
import type { JsonValue } from '../../core/http/types';
import { checkbox, dropdown, file, json, longText, shortText } from '../../core/props';

/**
 * CSV utilities — no-auth actions: a dependency-free RFC-4180 parser/serialiser plus `exceljs`.
 * Keep `exceljs`, not `xlsx@0.18.5` (frozen, unpatched CVEs); legacy binary `.xls` is rejected.
 */

/** Parse CSV text into a matrix of string cells (RFC-4180 quoting rules). */
function parseCsv(input: string, delimiter: string): string[][] {
  const d = delimiter.length > 0 ? delimiter.charAt(0) : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  while (i < input.length) {
    const c = input.charAt(i);
    if (inQuotes) {
      if (c === '"') {
        if (input.charAt(i + 1) === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += c;
      i += 1;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i += 1;
    } else if (c === d) {
      row.push(field);
      field = '';
      i += 1;
    } else if (c === '\r') {
      i += 1; // normalise CRLF — the LF that follows closes the row
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += 1;
    } else {
      field += c;
      i += 1;
    }
  }
  row.push(field);
  rows.push(row);
  // A file ending in a newline yields a trailing empty row — drop it.
  const last = rows[rows.length - 1];
  if (rows.length > 1 && last && last.length === 1 && last[0] === '') rows.pop();
  return rows;
}

/** Quote a cell if it contains the delimiter, a quote, or a newline. */
function encodeCell(value: string, delimiter: string): string {
  if (value.includes('"') || value.includes(delimiter) || value.includes('\n') || value.includes('\r')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function stringifyCell(value: JsonValue | undefined): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export const CSV_TO_JSON_TYPE = 'csv.convert_csv_to_json';
export interface CsvToJsonResult {
  result: JsonValue[];
}
export const convertCsvToJson = defineAction({
  type: CSV_TO_JSON_TYPE,
  name: 'Convert CSV to JSON',
  description: 'Parse CSV text into JSON rows (objects when a header row is present).',
  auth: { type: 'none' },
  props: {
    csv: longText({ label: 'CSV', required: true }),
    delimiter: shortText({ label: 'Delimiter', required: false, defaultValue: ',' }),
    hasHeader: checkbox({ label: 'First row is a header', required: false, defaultValue: true }),
  },
  run: ({ props }): Promise<CsvToJsonResult> => {
    const matrix = parseCsv(props.csv, props.delimiter ?? ',');
    if (matrix.length === 0) return Promise.resolve({ result: [] });
    if (props.hasHeader ?? true) {
      const [header, ...body] = matrix;
      const keys = header ?? [];
      const result = body.map((cells) => {
        const obj: { [k: string]: JsonValue } = {};
        keys.forEach((key, idx) => {
          obj[key] = cells[idx] ?? '';
        });
        return obj;
      });
      return Promise.resolve({ result });
    }
    return Promise.resolve({ result: matrix });
  },
});

export const JSON_TO_CSV_TYPE = 'csv.convert_json_to_csv';
export interface JsonToCsvResult {
  result: string;
}
export const convertJsonToCsv = defineAction({
  type: JSON_TO_CSV_TYPE,
  name: 'Convert JSON to CSV',
  description: 'Serialise a JSON array of objects into CSV text.',
  auth: { type: 'none' },
  props: {
    data: json({ label: 'Rows', description: 'A JSON array of objects.', required: true }),
    delimiter: shortText({ label: 'Delimiter', required: false, defaultValue: ',' }),
    includeHeader: checkbox({ label: 'Include header row', required: false, defaultValue: true }),
  },
  run: ({ props }): Promise<JsonToCsvResult> => {
    if (!Array.isArray(props.data)) {
      throw new ActionError({
        code: 'invalid_input',
        message: '"data" must be a JSON array',
        retryable: false,
      });
    }
    const rows = props.data.filter(
      (r): r is { [k: string]: JsonValue } => typeof r === 'object' && r !== null && !Array.isArray(r),
    );
    const columns: string[] = [];
    for (const row of rows) {
      for (const key of Object.keys(row)) if (!columns.includes(key)) columns.push(key);
    }
    const d = props.delimiter && props.delimiter.length > 0 ? props.delimiter.charAt(0) : ',';
    const lines: string[] = [];
    if (props.includeHeader ?? true) lines.push(columns.map((c) => encodeCell(c, d)).join(d));
    for (const row of rows) {
      lines.push(columns.map((col) => encodeCell(stringifyCell(row[col]), d)).join(d));
    }
    return Promise.resolve({ result: lines.join('\n') });
  },
});

export const EXCEL_TO_CSV_TYPE = 'csv.convert_excel_to_csv';
export interface ExcelToCsvResult {
  csv: string;
  sheet_name: string;
  available_sheets: string[];
}
export const convertExcelToCsv = defineAction({
  type: EXCEL_TO_CSV_TYPE,
  name: 'Convert Excel to CSV',
  description: 'Convert a sheet of an Excel (.xlsx/.xlsm) file into CSV text.',
  auth: { type: 'none' },
  props: {
    file: file({ label: 'Excel File', description: 'An .xlsx or .xlsm workbook.', required: true }),
    sheetName: shortText({
      label: 'Sheet Name',
      description: 'Name of the sheet to convert. Leave blank to use the first sheet.',
      required: false,
    }),
    delimiter: dropdown<string, false>({
      label: 'Delimiter',
      required: false,
      defaultValue: ',',
      options: [
        { label: 'Comma (,)', value: ',' },
        { label: 'Tab', value: '\t' },
        { label: 'Semicolon (;)', value: ';' },
      ],
    }),
  },
  run: async ({ props }): Promise<ExcelToCsvResult> => {
    const bytes = props.file.data;
    // XLSX/XLSM (ZIP) begins with "PK"; legacy XLS (OLE2) begins with 0xD0 0xCF.
    if (bytes.length < 2 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
      const legacy = bytes[0] === 0xd0 && bytes[1] === 0xcf;
      throw new ActionError({
        code: 'invalid_input',
        message: legacy
          ? 'Legacy binary .xls files are not supported — please re-save as .xlsx.'
          : 'The file does not appear to be a valid .xlsx/.xlsm workbook.',
        retryable: false,
      });
    }
    const workbook = new Workbook();
    try {
      // exceljs augments the global Buffer type; cast to its exact param type to bridge it.
      await workbook.xlsx.load(bytes as unknown as Parameters<typeof workbook.xlsx.load>[0]);
    } catch (err) {
      throw new ActionError({
        code: 'invalid_input',
        message: `Failed to read the workbook: ${err instanceof Error ? err.message : String(err)}`,
        retryable: false,
      });
    }
    const availableSheets = workbook.worksheets.map((ws) => ws.name);
    const wanted = props.sheetName?.trim();
    const worksheet = wanted && wanted.length > 0 ? workbook.getWorksheet(wanted) : workbook.worksheets[0];
    if (!worksheet) {
      throw new ActionError({
        code: 'invalid_input',
        message:
          wanted && wanted.length > 0
            ? `Sheet "${wanted}" not found. Available sheets: ${availableSheets.join(', ')}`
            : 'The workbook contains no sheets.',
        retryable: false,
      });
    }
    const d = props.delimiter && props.delimiter.length > 0 ? props.delimiter : ',';
    const columnCount = worksheet.columnCount;
    const lines: string[] = [];
    worksheet.eachRow({ includeEmpty: true }, (row) => {
      const cells: string[] = [];
      for (let c = 1; c <= columnCount; c++) cells.push(encodeCell(row.getCell(c).text ?? '', d));
      lines.push(cells.join(d));
    });
    return { csv: lines.join('\n'), sheet_name: worksheet.name, available_sheets: availableSheets };
  },
});
