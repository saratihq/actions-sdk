import { createHash } from 'node:crypto';

import { defineTrigger } from '../../core/trigger';
import type { JsonValue } from '../../core/http/types';
import { shortText } from '../../core/props';
import { sheetsAuth, spreadsheetIdProp, valuesUrl } from './common';

/** Polling trigger (`sheets.new_row`) — fires for each row added after activation; a row's identity is a hash of its CONTENT, never its position (Sheets exposes no row id). */
export const SHEETS_NEW_ROW_TYPE = 'sheets.new_row';

/** Store key for the set of content hashes already accounted for (baseline + emitted). */
const SEEN_HASHES_KEY = 'seenRowHashes';

/** Bound on the remembered content hashes — caps store growth on a hot sheet. */
const SEEN_CAP = 5000;

/** A normalised new-row event — trimmed to the fields a workflow reads. */
export interface SheetRowEvent {
  /** 1-based row number in the worksheet at the time of this poll. */
  rowNumber: number;
  /** The row's cells, left to right (unformatted values). */
  cells: JsonValue[];
  /** The row keyed by the header row (row 1), when a header is present. */
  fields: Record<string, JsonValue>;
}

interface ValueRange {
  range?: string;
  majorDimension?: string;
  values?: JsonValue[][];
}

/** Position-independent identity for a row: a hash of its cell content. */
function rowHash(cells: JsonValue[]): string {
  return createHash('sha256').update(JSON.stringify(cells)).digest('hex').slice(0, 32);
}

/** Build the header→cell object for a row, using row 1 as the header labels. */
function toFields(header: JsonValue[], row: JsonValue[]): Record<string, JsonValue> {
  const fields: Record<string, JsonValue> = {};
  for (let col = 0; col < header.length; col += 1) {
    const key = header[col];
    if (typeof key === 'string' && key.length > 0) fields[key] = row[col] ?? '';
  }
  return fields;
}

export const newRow = defineTrigger({
  type: SHEETS_NEW_ROW_TYPE,
  strategy: 'polling',
  name: 'New row',
  description: 'Fires when a row is added to a Google Sheets worksheet.',
  auth: sheetsAuth,
  props: {
    spreadsheetId: spreadsheetIdProp(),
    range: shortText<true>({
      label: 'Worksheet',
      description: 'Tab name (e.g. Sheet1) or A1 range covering the data, including the header row.',
      required: true,
    }),
  },
  sampleData: {
    rowNumber: 2,
    cells: ['Ada Lovelace', 'ada@example.com', 'Analytical Engine'],
    fields: { Name: 'Ada Lovelace', Email: 'ada@example.com', Project: 'Analytical Engine' },
  },
  async poll({ auth, props, http, store, lastPolledAt }): Promise<SheetRowEvent[]> {
    const res = await http.get<ValueRange>(valuesUrl(props.spreadsheetId, props.range), {
      auth,
      // Unformatted values keep the content hash stable across a viewer's locale.
      query: { valueRenderOption: 'UNFORMATTED_VALUE' },
    });
    const values = res.data.values ?? [];
    const header = values[0] ?? [];
    const dataRows = values.slice(1);

    const seenHashes = await store.get<string[]>(SEEN_HASHES_KEY);

    // Self-baseline: first activation records present rows and fires nothing; gated on
    // the watermark so a lost baseline can never emit the whole current window.
    if (lastPolledAt === undefined || seenHashes === undefined) {
      const baseline = dataRows.map((row) => rowHash(row ?? []));
      await store.set(SEEN_HASHES_KEY, baseline.slice(0, SEEN_CAP));
      return [];
    }

    const seenSet = new Set(seenHashes);
    const events: SheetRowEvent[] = [];
    const newHashes: string[] = [];
    for (let index = 0; index < dataRows.length; index += 1) {
      const row = dataRows[index] ?? [];
      const hash = rowHash(row);
      if (seenSet.has(hash)) continue;
      seenSet.add(hash);
      newHashes.push(hash);
      // rowNumber is 1-based; dataRows[0] is worksheet row 2 (row 1 is the header).
      events.push({ rowNumber: index + 2, cells: row, fields: toFields(header, row) });
    }
    if (newHashes.length > 0) {
      await store.set(SEEN_HASHES_KEY, [...newHashes, ...seenHashes].slice(0, SEEN_CAP));
    }
    return events;
  },
  // Must stay content-keyed to match the poll's own novelty test.
  dedupeKey: (event): string => rowHash(event.cells),
});
