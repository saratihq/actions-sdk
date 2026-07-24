import { createHash } from 'node:crypto';

import { defineTrigger } from '../../core/trigger';
import type { JsonValue } from '../../core/http/types';
import { shortText } from '../../core/props';
import { sheetsAuth, spreadsheetIdProp, valuesUrl } from './common';

/**
 * Polling trigger (`sheets.new_row`) — fires for each row added to a Google
 * Sheets worksheet after the trigger is enabled.
 *
 * Why polling rather than push: Google Sheets has NO row-level webhook. The only
 * push signal is a Drive `files.watch` on the whole spreadsheet, which fires on
 * any edit with an empty body and no row granularity — useless for "new row".
 * Polling is the correct approach.
 *
 * IDENTITY (why content, not position): `spreadsheets.values.get` returns a bare
 * 2-D grid — there is no per-row id and no per-row timestamp. Keying a row by its
 * 1-based POSITION is wrong: deleting a row then adding another re-uses a
 * position already emitted (so the new row is wrongly suppressed), and a
 * mid-sheet insert shifts every following row down (so the trailing positions
 * emit rows that never changed). Instead a row is judged NEW by a hash of its
 * cell CONTENT: the first poll records the content hashes of the rows already
 * present (they never fire), and each later poll emits exactly the rows whose
 * content hash has not been seen — insert-anywhere, delete-then-re-add safe. Rows
 * with byte-identical content collapse to one event (Sheets exposes no other
 * identity); that is a documented limit of the API, not a bug.
 *
 * `valueRenderOption=UNFORMATTED_VALUE` asks Sheets for the underlying cell
 * values (numbers as numbers, dates as serials) rather than locale-formatted
 * display strings, so both the hash and the fields a workflow reads are stable
 * across a viewer's locale or number-format changes.
 *
 * Row 1 is treated as the header, mapped onto each new row as `fields`.
 * Docs: https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/get
 */
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

/**
 * Position-independent identity for a row: a hash of its cell content. Canonical
 * JSON of the cell array is stable for a fixed value sequence, so the same data
 * hashes the same regardless of where the row currently sits in the sheet.
 */
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
      // Underlying values (numbers/serials), not locale-formatted display strings —
      // stable across a viewer's locale so the content hash and `fields` don't drift.
      query: { valueRenderOption: 'UNFORMATTED_VALUE' },
    });
    const values = res.data.values ?? [];
    const header = values[0] ?? [];
    const dataRows = values.slice(1);

    const seenHashes = await store.get<string[]>(SEEN_HASHES_KEY);

    // Self-baseline: the very first activation carries no watermark yet (and no
    // stored hash set). Record every present row's content hash and fire nothing
    // — only rows added *after* this point should fire. Gated on the harness
    // watermark so a lost/empty baseline can never emit the whole current window.
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
  // Content-keyed dedup: a row is the same event iff its cells are identical.
  // Matches the poll's own novelty test, so the SDK dedup layer agrees with it.
  dedupeKey: (event): string => rowHash(event.cells),
});
