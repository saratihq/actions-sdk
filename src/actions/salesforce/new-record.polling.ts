import { ActionError } from '../../core/errors';
import { shortText } from '../../core/props';
import { defineTrigger } from '../../core/trigger';
import {
  apiVersionProp,
  instanceUrlProp,
  salesforceAuth,
  salesforceBaseUrl,
  type SalesforceQueryResult,
} from './common';

/** Polling trigger (`salesforce.new_record`) — fires when a record of a chosen SObject is created, via a SOQL `CreatedDate` since-cursor poll. */
export const NEW_RECORD_TYPE = 'salesforce.new_record';

/** Seconds re-scanned each poll so a same-second-as-watermark record is never missed (id-dedup drops the re-emit). */
const OVERLAP_MS = 2_000;
/** Rows per poll; forward progress (ASC + advancing watermark) drains a larger backlog across polls. */
const POLL_LIMIT = 200;
/** SObject/field identifiers must be safe to interpolate into SOQL — Salesforce API names are `[A-Za-z0-9_]`, with `.` for relationships. */
const IDENTIFIER_RE = /^[A-Za-z0-9_.]+$/;

/** A normalised new-record event — id + type + creation time + the selected fields. */
export interface SalesforceRecordEvent {
  id: string;
  /** The SObject type, e.g. `Lead`. */
  sobject: string;
  /** ISO-8601 creation time. */
  createdDate: string;
  /** The record's returned fields (minus the `attributes` envelope). */
  fields: Record<string, unknown>;
}

/** A SOQL record row: an `attributes` envelope plus arbitrary selected fields. */
interface SalesforceRecordRow {
  attributes?: { type?: string; url?: string };
  Id?: string;
  CreatedDate?: string;
  [field: string]: unknown;
}

/** Format an epoch-millis as an unquoted SOQL datetime literal (`YYYY-MM-DDTHH:MM:SSZ`). */
function toSoqlLiteral(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Guard an identifier before it enters a SOQL string; reject anything outside the API-name charset. */
function assertIdentifier(value: string, what: string): string {
  if (!IDENTIFIER_RE.test(value)) {
    throw new ActionError({
      code: 'invalid_input',
      message: `invalid Salesforce ${what} "${value}"`,
      retryable: false,
    });
  }
  return value;
}

function toEvent(row: SalesforceRecordRow, sobject: string): SalesforceRecordEvent {
  const { attributes, ...fields } = row;
  return {
    id: row.Id ?? '',
    sobject: attributes?.type ?? sobject,
    createdDate: row.CreatedDate ?? '',
    fields,
  };
}

export const newRecord = defineTrigger({
  type: NEW_RECORD_TYPE,
  strategy: 'polling',
  name: 'New record',
  description: 'Fires when a record of a chosen object is created in Salesforce.',
  auth: salesforceAuth,
  props: {
    instanceUrl: instanceUrlProp(),
    apiVersion: apiVersionProp(),
    sobject: shortText<true>({
      label: 'Object',
      description: 'SObject to watch, e.g. Lead, Contact, Account, Opportunity.',
      required: true,
    }),
    fields: shortText({
      label: 'Extra fields',
      description: 'Comma-separated extra fields to return (Id and CreatedDate are always included).',
      required: false,
    }),
  },
  sampleData: {
    id: '00Q5f000001abcDEAX',
    sobject: 'Lead',
    createdDate: '2024-01-17T19:55:04.000+0000',
    fields: {
      Id: '00Q5f000001abcDEAX',
      Name: 'Jane Doe',
      Company: 'Acme',
      CreatedDate: '2024-01-17T19:55:04.000+0000',
    },
  },
  async poll({ auth, props, http, store }): Promise<SalesforceRecordEvent[]> {
    const sobject = assertIdentifier(props.sobject, 'object');
    const extra = (props.fields ?? '')
      .split(',')
      .map((f) => f.trim())
      .filter((f) => f.length > 0)
      .map((f) => assertIdentifier(f, 'field'));
    const selected = ['Id', 'CreatedDate', ...extra];
    const selectClause = [...new Set(selected)].join(', ');

    const stored = await store.get<number>('cursor');
    const nowMs = Date.now();
    // First poll: watermark = now, so history is never backfilled as "new".
    const sinceMs = stored === undefined ? nowMs : Math.max(0, stored - OVERLAP_MS);
    const soql =
      `SELECT ${selectClause} FROM ${sobject} ` +
      `WHERE CreatedDate > ${toSoqlLiteral(sinceMs)} ORDER BY CreatedDate ASC LIMIT ${POLL_LIMIT}`;

    const res = await http.get<SalesforceQueryResult<SalesforceRecordRow>>(
      `${salesforceBaseUrl(props.instanceUrl, props.apiVersion ?? 'v58.0')}/query`,
      { auth, query: { q: soql } },
    );
    const records = res.data.records ?? [];

    let maxCreated = stored ?? nowMs;
    for (const r of records) {
      const ms = Date.parse(r.CreatedDate ?? '');
      if (!Number.isNaN(ms) && ms > maxCreated) maxCreated = ms;
    }
    await store.set('cursor', maxCreated);

    return records.map((r) => toEvent(r, sobject));
  },
  dedupeKey: (event): string => event.id,
});
