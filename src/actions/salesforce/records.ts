import { defineAction } from '../../core/action';
import type { JsonValue } from '../../core/http/types';
import { json, longText, shortText } from '../../core/props';
import {
  apiVersionProp,
  instanceUrlProp,
  salesforceAuth,
  salesforceBaseUrl,
  type SalesforceQueryResult,
  type SalesforceWriteResult,
} from './common';

/** Public types — stable public catalog ids. */
export const RUN_QUERY_TYPE = 'salesforce.run_query';
export const SEARCH_TYPE = 'salesforce.search';
export const CREATE_RECORD_TYPE = 'salesforce.create_record';
export const GET_RECORD_TYPE = 'salesforce.get_record';
export const UPDATE_RECORD_TYPE = 'salesforce.update_record';
export const DELETE_RECORD_TYPE = 'salesforce.delete_record';

/**
 * Run a SOQL query. Read-only and the benign live-smoke action for Salesforce,
 * e.g. `SELECT Id, Name FROM Account LIMIT 5`.
 */
export const runQuery = defineAction({
  type: RUN_QUERY_TYPE,
  name: 'Run SOQL query',
  description: 'Run a SOQL query against Salesforce.',
  auth: salesforceAuth,
  props: {
    instanceUrl: instanceUrlProp(),
    apiVersion: apiVersionProp(),
    query: longText<true>({
      label: 'SOQL',
      description: 'e.g. SELECT Id, Name FROM Account LIMIT 5',
      required: true,
    }),
  },
  async run({ auth, props, http }): Promise<SalesforceQueryResult> {
    const res = await http.get<SalesforceQueryResult>(
      `${salesforceBaseUrl(props.instanceUrl, props.apiVersion ?? 'v58.0')}/query`,
      { auth, query: { q: props.query } },
    );
    return res.data;
  },
});

/** Run a SOSL search, e.g. `FIND {Acme} IN NAME FIELDS RETURNING Account(Id, Name)`. */
export const search = defineAction({
  type: SEARCH_TYPE,
  name: 'Search (SOSL)',
  description: 'Run a SOSL search across Salesforce objects.',
  auth: salesforceAuth,
  props: {
    instanceUrl: instanceUrlProp(),
    apiVersion: apiVersionProp(),
    query: longText<true>({
      label: 'SOSL',
      description: 'e.g. FIND {Acme} IN NAME FIELDS RETURNING Account(Id, Name)',
      required: true,
    }),
  },
  async run({ auth, props, http }): Promise<{ searchRecords: Array<Record<string, unknown>> }> {
    const res = await http.get<{ searchRecords: Array<Record<string, unknown>> }>(
      `${salesforceBaseUrl(props.instanceUrl, props.apiVersion ?? 'v58.0')}/search`,
      { auth, query: { q: props.query } },
    );
    return res.data;
  },
});

/** Create a record of any SObject from a `{ field: value }` map. */
export const createRecord = defineAction({
  type: CREATE_RECORD_TYPE,
  name: 'Create record',
  description: 'Create a Salesforce record of a given object type.',
  auth: salesforceAuth,
  props: {
    instanceUrl: instanceUrlProp(),
    apiVersion: apiVersionProp(),
    sobject: shortText<true>({
      label: 'Object',
      description: 'e.g. Account, Contact, Lead.',
      required: true,
    }),
    fields: json<true>({ label: 'Fields', description: 'A { field: value } object.', required: true }),
  },
  async run({ auth, props, http }): Promise<SalesforceWriteResult> {
    const res = await http.post<SalesforceWriteResult>(
      `${salesforceBaseUrl(props.instanceUrl, props.apiVersion ?? 'v58.0')}/sobjects/${encodeURIComponent(props.sobject)}`,
      { auth, body: props.fields },
    );
    return res.data;
  },
});

/** Retrieve a record by id, optionally limiting the fields returned. */
export const getRecord = defineAction({
  type: GET_RECORD_TYPE,
  name: 'Get record',
  description: 'Retrieve a Salesforce record by id.',
  auth: salesforceAuth,
  props: {
    instanceUrl: instanceUrlProp(),
    apiVersion: apiVersionProp(),
    sobject: shortText<true>({ label: 'Object', required: true }),
    recordId: shortText<true>({ label: 'Record id', required: true }),
    fields: shortText({ label: 'Fields', description: 'Comma-separated fields to return.', required: false }),
  },
  async run({ auth, props, http }): Promise<Record<string, unknown>> {
    const res = await http.get<Record<string, unknown>>(
      `${salesforceBaseUrl(props.instanceUrl, props.apiVersion ?? 'v58.0')}/sobjects/${encodeURIComponent(props.sobject)}/${encodeURIComponent(props.recordId)}`,
      { auth, query: { fields: props.fields } },
    );
    return res.data;
  },
});

/**
 * Update fields on a record. Salesforce replies `204 No Content` on success, so
 * this returns a synthesised `{ id, success }` rather than an empty body.
 */
export const updateRecord = defineAction({
  type: UPDATE_RECORD_TYPE,
  name: 'Update record',
  description: 'Update fields on a Salesforce record.',
  auth: salesforceAuth,
  props: {
    instanceUrl: instanceUrlProp(),
    apiVersion: apiVersionProp(),
    sobject: shortText<true>({ label: 'Object', required: true }),
    recordId: shortText<true>({ label: 'Record id', required: true }),
    fields: json<true>({ label: 'Fields', description: 'A { field: value } object.', required: true }),
  },
  async run({ auth, props, http }): Promise<SalesforceWriteResult> {
    await http.patch<JsonValue>(
      `${salesforceBaseUrl(props.instanceUrl, props.apiVersion ?? 'v58.0')}/sobjects/${encodeURIComponent(props.sobject)}/${encodeURIComponent(props.recordId)}`,
      { auth, body: props.fields },
    );
    return { id: props.recordId, success: true };
  },
});

/** Delete a record by id. Salesforce replies `204 No Content` on success. */
export const deleteRecord = defineAction({
  type: DELETE_RECORD_TYPE,
  name: 'Delete record',
  description: 'Delete a Salesforce record by id.',
  auth: salesforceAuth,
  props: {
    instanceUrl: instanceUrlProp(),
    apiVersion: apiVersionProp(),
    sobject: shortText<true>({ label: 'Object', required: true }),
    recordId: shortText<true>({ label: 'Record id', required: true }),
  },
  async run({ auth, props, http }): Promise<SalesforceWriteResult> {
    await http.delete<JsonValue>(
      `${salesforceBaseUrl(props.instanceUrl, props.apiVersion ?? 'v58.0')}/sobjects/${encodeURIComponent(props.sobject)}/${encodeURIComponent(props.recordId)}`,
      { auth },
    );
    return { id: props.recordId, success: true };
  },
});
