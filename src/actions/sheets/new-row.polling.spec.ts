import type { JsonValue, NormalizedResponse } from '../../core/http/types';
import { FakeTransport, stubAuth } from '../../testing/fakes';
import { MemoryStore } from '../../testing/memory-store';
import { type SheetRowEvent, newRow } from './new-row.polling';

const PROPS = { spreadsheetId: '1qpyC0Xz', range: 'Sheet1' };

/** Build a REAL Sheets `values.get` ValueRange response for the given grid. */
function valueRange(values: JsonValue[][]): NormalizedResponse {
  return { status: 200, headers: {}, data: { range: 'Sheet1', majorDimension: 'ROWS', values } };
}

/** Poll once against a fixed grid; returns the events and the transport that saw the request. */
async function pollGrid(
  store: MemoryStore,
  grid: JsonValue[][],
): Promise<{
  events: SheetRowEvent[];
  transport: FakeTransport;
}> {
  const transport = new FakeTransport(() => valueRange(grid));
  const result = await newRow.runPoll({ auth: stubAuth(transport), props: PROPS, store });
  return { events: result.events, transport };
}

const HEADER = ['Name', 'Email', 'Amount'];
/** UNFORMATTED_VALUE returns numbers as numbers — Amount is a real number, not a display string. */
const ADA: JsonValue[] = ['Ada Lovelace', 'ada@example.com', 1815];
const ALAN: JsonValue[] = ['Alan Turing', 'alan@example.com', 1912];
const GRACE: JsonValue[] = ['Grace Hopper', 'grace@example.com', 1906];

describe('sheets.new_row polling trigger', () => {
  it('self-baselines on the first poll (empty watermark): records content hashes and fires nothing', async () => {
    const store = new MemoryStore();
    const { events } = await pollGrid(store, [HEADER, ADA]);

    expect(events).toEqual([]);
    // A content-hash baseline is persisted (not a positional row count), so later
    // rows are judged new by their data, and existing rows never fire.
    const hashes = store.snapshot().seenRowHashes as string[];
    expect(hashes).toHaveLength(1);
    expect(typeof hashes[0]).toBe('string');
    expect(store.snapshot().rowCount).toBeUndefined();
  });

  it('asks Sheets for UNFORMATTED_VALUE so hashes and fields are locale-stable', async () => {
    const store = new MemoryStore();
    const { transport } = await pollGrid(store, [HEADER, ADA]);
    expect(transport.requests[0]?.url).toContain('valueRenderOption=UNFORMATTED_VALUE');
  });

  it('after the baseline, emits an appended row with header-keyed fields and a 1-based row number', async () => {
    const store = new MemoryStore();
    await pollGrid(store, [HEADER, ADA]);

    const { events } = await pollGrid(store, [HEADER, ADA, ALAN]);
    expect(events).toEqual<SheetRowEvent[]>([
      {
        rowNumber: 3,
        cells: ALAN,
        fields: { Name: 'Alan Turing', Email: 'alan@example.com', Amount: 1912 },
      },
    ]);
  });

  it('the same appended row never fires twice (content dedup across polls)', async () => {
    const store = new MemoryStore();
    await pollGrid(store, [HEADER, ADA]);
    const first = await pollGrid(store, [HEADER, ADA, ALAN]);
    const second = await pollGrid(store, [HEADER, ADA, ALAN]);

    expect(first.events.map((e) => e.cells)).toEqual([ALAN]);
    expect(second.events).toEqual([]);
  });

  it('THE DEFECT: a delete-then-re-add that reuses a previously-emitted position still fires', async () => {
    const store = new MemoryStore();
    await pollGrid(store, [HEADER, ADA]); // baseline: {ADA}
    await pollGrid(store, [HEADER, ADA, ALAN]); // ALAN fires, now at row 3
    // Delete ALAN, add GRACE — GRACE lands at row 3, the SAME position ALAN held.
    // Positional keying (String(rowNumber)="3") would suppress it; content keying fires it.
    const { events } = await pollGrid(store, [HEADER, ADA, GRACE]);

    expect(events).toEqual<SheetRowEvent[]>([
      {
        rowNumber: 3,
        cells: GRACE,
        fields: { Name: 'Grace Hopper', Email: 'grace@example.com', Amount: 1906 },
      },
    ]);
  });

  it('THE DEFECT: a mid-sheet insert fires only the inserted row, not the shifted trailing rows', async () => {
    const store = new MemoryStore();
    await pollGrid(store, [HEADER, ADA, ALAN]); // baseline: {ADA, ALAN}
    // Insert GRACE between ADA and ALAN: ADA row 2, GRACE row 3, ALAN shifts to row 4.
    // Positional keying would emit the trailing row 4 (ALAN, unchanged); content
    // keying emits only GRACE, the row that is actually new.
    const { events } = await pollGrid(store, [HEADER, ADA, GRACE, ALAN]);

    expect(events).toEqual<SheetRowEvent[]>([
      {
        rowNumber: 3,
        cells: GRACE,
        fields: { Name: 'Grace Hopper', Email: 'grace@example.com', Amount: 1906 },
      },
    ]);
  });

  it('append-only stays correct: successive appends each fire exactly once', async () => {
    const store = new MemoryStore();
    await pollGrid(store, [HEADER, ADA]); // baseline
    const a = await pollGrid(store, [HEADER, ADA, ALAN]);
    const b = await pollGrid(store, [HEADER, ADA, ALAN, GRACE]);

    expect(a.events.map((e) => e.cells)).toEqual([ALAN]);
    expect(b.events.map((e) => e.cells)).toEqual([GRACE]);
  });
});
