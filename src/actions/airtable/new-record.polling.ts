import { defineTrigger } from '../../core/trigger';
import { cursorInBody, paginate } from '../../core/http/pagination';
import type { JsonValue } from '../../core/http/types';
import { dropdown, shortText } from '../../core/props';
import { AIRTABLE_API_BASE, type AirtableRecord, airtableAuth, baseOptions } from './common';

/**
 * Polling trigger (`airtable.new_record`) — fires for each record created in a
 * table after the trigger is enabled.
 *
 * Why polling rather than webhooks: Airtable DOES expose a per-base webhook API
 * (`POST /v0/bases/{baseId}/webhooks`), but it is not a fit for this SDK's
 * registered-webhook contract for two independent reasons: (1) the inbound
 * notification is a content-free *ping* — it carries only `{ base, webhook,
 * timestamp }`, never the changed records, so a second cursor-paged `/payloads`
 * endpoint must be called to learn what changed; and (2) Airtable generates its
 * OWN `macSecretBase64` at registration, so the runtime's `ctx.secret` can't be
 * injected and the `verify(request, secrets)` seam can't receive the
 * provider-minted key. Polling by creation time is therefore correct by
 * construction: `filterByFormula` restricts the read to records created after the
 * last poll, the SDK dedupes by record id, and a small overlap window guards the
 * boundary. Docs: https://airtable.com/developers/web/api/list-records
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
    // First activation: baseline the watermark, don't backfill the whole table.
    // The SDK stamps `lastPolledAt = now`; the next poll only sees records created after it.
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
