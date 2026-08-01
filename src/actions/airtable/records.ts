import { defineAction } from '../../core/action';
import { cursorInBody, paginate } from '../../core/http/pagination';
import type { JsonValue } from '../../core/http/types';
import { dropdown, json, number, shortText } from '../../core/props';
import {
  AIRTABLE_API_BASE,
  type AirtableRecord,
  airtableAuth,
  baseOptions,
  checkboxTypecast,
} from './common';

/** Public types — stable public catalog ids. */
export const CREATE_RECORD_TYPE = 'airtable.create_record';
export const GET_RECORD_TYPE = 'airtable.get_record';
export const LIST_RECORDS_TYPE = 'airtable.list_records';
export const UPDATE_RECORD_TYPE = 'airtable.update_record';
export const DELETE_RECORD_TYPE = 'airtable.delete_record';

interface RecordsEnvelope {
  records?: AirtableRecord[];
  offset?: string;
}

/** The `DELETE` response. */
export interface AirtableDeleted {
  id: string;
  deleted: boolean;
}

/** Build the `/v0/{baseId}/{tableId}` URL, encoding a table name-or-id safely. */
function tableUrl(baseId: string, tableId: string): string {
  return `${AIRTABLE_API_BASE}/${encodeURIComponent(baseId)}/${encodeURIComponent(tableId)}`;
}

/** Create a record; `tableId` is free text because the loader contract cannot pass the chosen base. */
export const createRecord = defineAction({
  type: CREATE_RECORD_TYPE,
  name: 'Create record',
  description: 'Create a record in an Airtable table.',
  auth: airtableAuth,
  props: {
    baseId: dropdown<string, true>({
      label: 'Base',
      description: 'Loaded live from your account.',
      required: true,
      options: ({ auth, http }) => baseOptions(http, auth),
    }),
    tableId: shortText<true>({ label: 'Table', description: 'Table name or id.', required: true }),
    fields: json<true>({ label: 'Fields', description: 'A { column: value } object.', required: true }),
    typecast: checkboxTypecast(),
  },
  async run({ auth, props, http }): Promise<AirtableRecord> {
    const res = await http.post<AirtableRecord>(tableUrl(props.baseId, props.tableId), {
      auth,
      body: { fields: props.fields, typecast: props.typecast ?? true },
    });
    return res.data;
  },
});

/** Retrieve a single record by id. Read-only. */
export const getRecord = defineAction({
  type: GET_RECORD_TYPE,
  name: 'Get record',
  description: 'Retrieve an Airtable record by id.',
  auth: airtableAuth,
  props: {
    baseId: dropdown<string, true>({
      label: 'Base',
      required: true,
      options: ({ auth, http }) => baseOptions(http, auth),
    }),
    tableId: shortText<true>({ label: 'Table', description: 'Table name or id.', required: true }),
    recordId: shortText<true>({ label: 'Record id', required: true }),
  },
  async run({ auth, props, http }): Promise<AirtableRecord> {
    const res = await http.get<AirtableRecord>(
      `${tableUrl(props.baseId, props.tableId)}/${encodeURIComponent(props.recordId)}`,
      { auth },
    );
    return res.data;
  },
});

/** List records in a table, following Airtable's `offset` cursor up to `maxRecords`. */
export const listRecords = defineAction({
  type: LIST_RECORDS_TYPE,
  name: 'List records',
  description: 'List records in an Airtable table.',
  auth: airtableAuth,
  props: {
    baseId: dropdown<string, true>({
      label: 'Base',
      required: true,
      options: ({ auth, http }) => baseOptions(http, auth),
    }),
    tableId: shortText<true>({ label: 'Table', description: 'Table name or id.', required: true }),
    filterByFormula: shortText({
      label: 'Filter formula',
      description: 'Airtable formula, e.g. {Status}="Done".',
      required: false,
    }),
    view: shortText({ label: 'View', description: 'View name or id to read from.', required: false }),
    maxRecords: number({ label: 'Max records', required: false, defaultValue: 100 }),
  },
  async run({ auth, props, http }): Promise<{ records: AirtableRecord[]; count: number }> {
    const records = await paginate<AirtableRecord>({
      http,
      auth,
      url: tableUrl(props.baseId, props.tableId),
      query: {
        pageSize: 100,
        filterByFormula: props.filterByFormula,
        view: props.view,
      },
      extractItems: (res) => (res.data as RecordsEnvelope).records ?? [],
      nextPage: cursorInBody({ cursorPath: ['offset'], cursorParam: 'offset' }),
      maxItems: props.maxRecords ?? 100,
    });
    return { records, count: records.length };
  },
});

/** Update (patch) fields on a record; unspecified fields are left unchanged. */
export const updateRecord = defineAction({
  type: UPDATE_RECORD_TYPE,
  name: 'Update record',
  description: 'Update fields on an Airtable record.',
  auth: airtableAuth,
  props: {
    baseId: dropdown<string, true>({
      label: 'Base',
      required: true,
      options: ({ auth, http }) => baseOptions(http, auth),
    }),
    tableId: shortText<true>({ label: 'Table', description: 'Table name or id.', required: true }),
    recordId: shortText<true>({ label: 'Record id', required: true }),
    fields: json<true>({ label: 'Fields', description: 'A { column: value } object.', required: true }),
    typecast: checkboxTypecast(),
  },
  async run({ auth, props, http }): Promise<AirtableRecord> {
    const body: Record<string, JsonValue> = { fields: props.fields };
    if (props.typecast !== undefined) body.typecast = props.typecast;
    const res = await http.patch<AirtableRecord>(
      `${tableUrl(props.baseId, props.tableId)}/${encodeURIComponent(props.recordId)}`,
      { auth, body },
    );
    return res.data;
  },
});

/** Delete a record. */
export const deleteRecord = defineAction({
  type: DELETE_RECORD_TYPE,
  name: 'Delete record',
  description: 'Delete an Airtable record.',
  auth: airtableAuth,
  props: {
    baseId: dropdown<string, true>({
      label: 'Base',
      required: true,
      options: ({ auth, http }) => baseOptions(http, auth),
    }),
    tableId: shortText<true>({ label: 'Table', description: 'Table name or id.', required: true }),
    recordId: shortText<true>({ label: 'Record id', required: true }),
  },
  async run({ auth, props, http }): Promise<AirtableDeleted> {
    const res = await http.delete<AirtableDeleted>(
      `${tableUrl(props.baseId, props.tableId)}/${encodeURIComponent(props.recordId)}`,
      { auth },
    );
    return res.data;
  },
});
