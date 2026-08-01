import { defineTrigger } from '../../core/trigger';
import { cursorInBody, paginate } from '../../core/http/pagination';
import type { JsonValue } from '../../core/http/types';
import { dropdown, shortText } from '../../core/props';
import { AIRTABLE_API_BASE, type AirtableRecord, airtableAuth, baseOptions } from './common';

/**
 * Fires for each record created after the trigger is enabled. Polling, not webhooks: Airtable's webhook
 * ping carries no records and mints its own secret, so it cannot meet the registered-webhook contract.
 */
export const AIRTABLE_NEW_RECORD_TYPE = 'airtable.new_record';

/** Re-scan overlap (2 min) so a record created mid-poll is never missed; dedupe kills the double. */
const OVERLAP_MS = 120_000;
/** Hard cap on records collected per poll — bounds a burst without unbounded paging. */
const MAX_PER_POLL = 1000;

/** A normalised new-record event — trimmed to the fields a workflow reads. */
export interface AirtableRecordEvent {
  /** Airtable record id (`rec…`). */
  id: string;
  /** ISO 8601 creation time. */
  createdTime: string;
  /** The record's `{ column: value }` map — the table's shape, not the SDK's. */
  fields: Record<string, JsonValue>;
  baseId: string;
  tableId: string;
}

/** Build the `/v0/{baseId}/{tableId}` URL, encoding both segments safely. */
function tableUrl(baseId: string, tableId: string): string {
  return `${AIRTABLE_API_BASE}/${encodeURIComponent(baseId)}/${encodeURIComponent(tableId)}`;
}

/** Format an epoch-ms instant as `YYYY-MM-DD HH:mm:ss` in UTC — the exact shape DATETIME_PARSE reads. */
function airtableUtc(ms: number): string {
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
  );
}

interface RecordsEnvelope {
  records?: AirtableRecord[];
  offset?: string;
}

export const newRecord = defineTrigger({
  type: AIRTABLE_NEW_RECORD_TYPE,
  strategy: 'polling',
  name: 'New record',
  description: 'Fires when a record is created in an Airtable table.',
  auth: airtableAuth,
  props: {
    baseId: dropdown<string, true>({
      label: 'Base',
      description: 'Loaded live from your account.',
      required: true,
      options: ({ auth, http }) => baseOptions(http, auth),
    }),
    tableId: shortText<true>({ label: 'Table', description: 'Table name or id.', required: true }),
    view: shortText({
      label: 'View',
      description: 'Optional view name or id to scope the read.',
      required: false,
    }),
  },
  sampleData: {
    id: 'rec560UJdUtocSouk',
    createdTime: '2026-07-20T21:03:48.000Z',
    fields: { Name: 'Ada Lovelace', Status: 'Todo' },
    baseId: 'appXYZ123',
    tableId: 'Tasks',
  },
  async poll({ auth, props, http, lastPolledAt }): Promise<AirtableRecordEvent[]> {
    // First activation baselines the watermark rather than backfilling the whole table.
    if (!lastPolledAt) return [];

    const cutoff = airtableUtc(Date.parse(lastPolledAt) - OVERLAP_MS);
    const records = await paginate<AirtableRecord>({
      http,
      auth,
      url: tableUrl(props.baseId, props.tableId),
      query: {
        pageSize: 100,
        filterByFormula: `IS_AFTER(CREATED_TIME(), DATETIME_PARSE('${cutoff}', 'YYYY-MM-DD HH:mm:ss'))`,
        ...(props.view ? { view: props.view } : {}),
      },
      extractItems: (res) => (res.data as RecordsEnvelope).records ?? [],
      nextPage: cursorInBody({ cursorPath: ['offset'], cursorParam: 'offset' }),
      maxItems: MAX_PER_POLL,
    });

    return records
      .slice()
      .sort((a, b) => b.createdTime.localeCompare(a.createdTime))
      .map((record) => ({
        id: record.id,
        createdTime: record.createdTime,
        fields: record.fields,
        baseId: props.baseId,
        tableId: props.tableId,
      }));
  },
  dedupeKey: (event): string => event.id,
});
