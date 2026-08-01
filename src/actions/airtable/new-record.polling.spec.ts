import type { NormalizedResponse } from '../../core/http/types';
import { FakeTransport, stubAuth } from '../../testing/fakes';
import { MemoryStore } from '../../testing/memory-store';
import { type AirtableRecordEvent, newRecord } from './new-record.polling';

const PROPS = { baseId: 'appXYZ123', tableId: 'Tasks' };

/** A real Airtable list-records envelope: `{ records: [{ id, createdTime, fields }] }`. */
const RECORDS_RESPONSE: NormalizedResponse = {
  status: 200,
  headers: {},
  data: {
    records: [
      {
        id: 'rec560UJdUtocSouk',
        createdTime: '2026-07-20T21:03:48.000Z',
        fields: { Name: 'Ada Lovelace', Status: 'Todo' },
      },
      {
        id: 'recwPQt8bnbG0eLcm',
        createdTime: '2026-07-20T22:15:10.000Z',
        fields: { Name: 'Alan Turing', Status: 'Done' },
      },
    ],
  },
};

describe('airtable.new_record polling trigger', () => {
  it('baselines on first poll: no watermark yet, so it fires nothing and calls no network', async () => {
    const transport = new FakeTransport(() => {
      throw new Error('first poll must not call the network');
    });
    const result = await newRecord.runPoll({
      auth: stubAuth(transport),
      props: PROPS,
      store: new MemoryStore(),
    });
    expect(result.events).toEqual([]);
    expect(transport.requests).toHaveLength(0);
  });

  it('after the baseline, reads records created since the watermark and normalises them', async () => {
    const store = new MemoryStore();
    // First (baseline) poll stamps `lastPolledAt`.
    await newRecord.runPoll({
      auth: stubAuth(new FakeTransport(() => ({ status: 200, headers: {}, data: { records: [] } }))),
      props: PROPS,
      store,
    });

    const transport = new FakeTransport(() => RECORDS_RESPONSE);
    const result = await newRecord.runPoll({ auth: stubAuth(transport), props: PROPS, store });

    // Newest-first, trimmed to the normalised event shape.
    expect(result.events).toEqual<AirtableRecordEvent[]>([
      {
        id: 'recwPQt8bnbG0eLcm',
        createdTime: '2026-07-20T22:15:10.000Z',
        fields: { Name: 'Alan Turing', Status: 'Done' },
        baseId: 'appXYZ123',
        tableId: 'Tasks',
      },
      {
        id: 'rec560UJdUtocSouk',
        createdTime: '2026-07-20T21:03:48.000Z',
        fields: { Name: 'Ada Lovelace', Status: 'Todo' },
        baseId: 'appXYZ123',
        tableId: 'Tasks',
      },
    ]);

    // The read is scoped by a creation-time formula against the right table.
    const sent = transport.requests[0];
    expect(sent?.method).toBe('GET');
    expect(sent?.url).toContain('https://api.airtable.com/v0/appXYZ123/Tasks');
    const formula = decodeURIComponent(sent?.url ?? '').replace(/\+/g, ' ');
    expect(formula).toContain("IS_AFTER(CREATED_TIME(), DATETIME_PARSE('");
    expect(formula).toContain("'YYYY-MM-DD HH:mm:ss')");
  });

  it('dedupes by record id — a record already emitted never fires twice', async () => {
    const store = new MemoryStore();
    await newRecord.runPoll({
      auth: stubAuth(new FakeTransport(() => ({ status: 200, headers: {}, data: { records: [] } }))),
      props: PROPS,
      store,
    });
    const first = await newRecord.runPoll({
      auth: stubAuth(new FakeTransport(() => RECORDS_RESPONSE)),
      props: PROPS,
      store,
    });
    const second = await newRecord.runPoll({
      auth: stubAuth(new FakeTransport(() => RECORDS_RESPONSE)),
      props: PROPS,
      store,
    });
    expect(first.events.map((e) => e.id)).toEqual(['recwPQt8bnbG0eLcm', 'rec560UJdUtocSouk']);
    expect(second.events).toEqual([]);
  });
});
