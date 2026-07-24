export {
  AIRTABLE_API_BASE,
  type AirtableBase,
  type AirtableRecord,
  airtableAuth,
  baseOptions,
  listAirtableBases,
} from './common';
export {
  type AirtableDeleted,
  CREATE_RECORD_TYPE,
  createRecord,
  DELETE_RECORD_TYPE,
  deleteRecord,
  GET_RECORD_TYPE,
  getRecord,
  LIST_RECORDS_TYPE,
  listRecords,
  UPDATE_RECORD_TYPE,
  updateRecord,
} from './records';
export { LIST_BASES_TYPE, listBases } from './bases';
export { AIRTABLE_NEW_RECORD_TYPE, newRecord, type AirtableRecordEvent } from './new-record.polling';

import { listBases } from './bases';
import { createRecord, deleteRecord, getRecord, listRecords, updateRecord } from './records';

/** Every Airtable action, for catalog builds and registration. */
export const airtableActions = [
  createRecord,
  getRecord,
  listRecords,
  updateRecord,
  deleteRecord,
  listBases,
] as const;
