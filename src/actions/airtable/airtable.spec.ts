import { HttpClient } from '../../core/http/client';
import type { NormalizedRequest, NormalizedResponse } from '../../core/http/types';
import { FakeTransport, stubAuth } from '../../testing/fakes';
import { listBases } from './bases';
import { createRecord, deleteRecord, getRecord, listRecords, updateRecord } from './records';

/**
 * Golden offline tests for the Airtable actions. A {@link FakeTransport} replays
 * canned Airtable responses and records the request, so the tests assert URL +
 * body shaping (including offset pagination and the live base picker) without a
 * connection.
 */
function fake(handler: (req: NormalizedRequest, i: number) => NormalizedResponse) {
  const transport = new FakeTransport(handler);
  return { auth: stubAuth(transport, 'apiKey'), http: new HttpClient(), transport };
}

describe('airtable.create_record', () => {
  it('POSTs fields + typecast to the base/table URL', async () => {
    const record = { id: 'rec1', createdTime: 't', fields: { Name: 'Ada' } };
    const { auth, http, transport } = fake(() => ({ status: 200, headers: {}, data: record }));
    const out = await createRecord.execute({
      auth,
      http,
      props: { baseId: 'appABC', tableId: 'Tasks', fields: { Name: 'Ada' } },
    });
    expect(out).toEqual(record);
    const req = transport.requests[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('https://api.airtable.com/v0/appABC/Tasks');
    expect(req.body).toEqual({ fields: { Name: 'Ada' }, typecast: true });
  });
});

describe('airtable.get_record', () => {
  it('reads a record by id', async () => {
    const record = { id: 'rec1', createdTime: 't', fields: {} };
    const { auth, http, transport } = fake(() => ({ status: 200, headers: {}, data: record }));
    const out = await getRecord.execute({
      auth,
      http,
      props: { baseId: 'appABC', tableId: 'Tasks', recordId: 'rec1' },
    });
    expect(out.id).toBe('rec1');
    expect(transport.requests[0]!.url).toBe('https://api.airtable.com/v0/appABC/Tasks/rec1');
  });
});

describe('airtable.list_records', () => {
  it('follows the offset cursor across pages up to maxRecords', async () => {
    const { auth, http, transport } = fake((_req, i) =>
      i === 0
        ? {
            status: 200,
            headers: {},
            data: { records: [{ id: 'r1', createdTime: 't', fields: {} }], offset: 'off1' },
          }
        : { status: 200, headers: {}, data: { records: [{ id: 'r2', createdTime: 't', fields: {} }] } },
    );
    const out = await listRecords.execute({
      auth,
      http,
      props: { baseId: 'appABC', tableId: 'Tasks', maxRecords: 10 },
    });
    expect(out.count).toBe(2);
    expect(transport.requests).toHaveLength(2);
    expect(transport.requests[1]!.url).toContain('offset=off1');
  });
});

describe('airtable.update_record', () => {
  it('PATCHes fields to the record URL', async () => {
    const { auth, http, transport } = fake(() => ({
      status: 200,
      headers: {},
      data: { id: 'rec1', createdTime: 't', fields: { Name: 'Grace' } },
    }));
    await updateRecord.execute({
      auth,
      http,
      props: { baseId: 'appABC', tableId: 'Tasks', recordId: 'rec1', fields: { Name: 'Grace' } },
    });
    const req = transport.requests[0]!;
    expect(req.method).toBe('PATCH');
    expect(req.url).toBe('https://api.airtable.com/v0/appABC/Tasks/rec1');
    expect(req.body).toEqual({ fields: { Name: 'Grace' }, typecast: true });
  });
});

describe('airtable.delete_record', () => {
  it('DELETEs the record', async () => {
    const { auth, http, transport } = fake(() => ({
      status: 200,
      headers: {},
      data: { id: 'rec1', deleted: true },
    }));
    const out = await deleteRecord.execute({
      auth,
      http,
      props: { baseId: 'appABC', tableId: 'Tasks', recordId: 'rec1' },
    });
    expect(out.deleted).toBe(true);
    expect(transport.requests[0]!.method).toBe('DELETE');
  });
});

describe('airtable.list_bases + base picker', () => {
  it('lists bases and the picker maps name→id', async () => {
    const { auth, http } = fake(() => ({
      status: 200,
      headers: {},
      data: { bases: [{ id: 'appABC', name: 'CRM', permissionLevel: 'create' }] },
    }));
    const out = await listBases.execute({ auth, http, props: {} });
    expect(out.count).toBe(1);
    const picker = await createRecord.loadOptions('baseId', { auth, http });
    expect(picker.options[0]).toEqual({ label: 'CRM', value: 'appABC' });
  });

  it('the base picker is inert without a connection', async () => {
    const result = await createRecord.loadOptions('baseId', {});
    expect(result.disabled).toBe(true);
  });
});
