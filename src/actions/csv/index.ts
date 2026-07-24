export {
  CSV_TO_JSON_TYPE,
  convertCsvToJson,
  convertExcelToCsv,
  convertJsonToCsv,
  type CsvToJsonResult,
  EXCEL_TO_CSV_TYPE,
  type ExcelToCsvResult,
  JSON_TO_CSV_TYPE,
  type JsonToCsvResult,
} from './csv';

import { convertCsvToJson, convertExcelToCsv, convertJsonToCsv } from './csv';

/** Every CSV action, for catalog builds and registration. */
export const csvActions = [convertCsvToJson, convertJsonToCsv, convertExcelToCsv] as const;
