import { HttpClient } from '../../core/http/client';
import type { NormalizedRequest, NormalizedResponse } from '../../core/http/types';
import { FakeTransport, stubAuth } from '../../testing/fakes';
import { createRecord, deleteRecord, getRecord, runQuery, updateRecord } from './records';

const INSTANCE = 'https://acme.my.salesforce.com';
const BASE = `${INSTANCE}/services/data/v58.0`;

function fake(handler: (req: NormalizedRequest) => NormalizedResponse) {
  const transport = new FakeTransport(handler);
  return { auth: stubAuth(transport, 'oauth2'), http: new HttpClient(), transport };
}

describe('salesforce.run_query', () => {
  it('GETs /query with the SOQL as q', async () => {
    const { auth, http, transport } = fake(() => ({
      status: 200,
      headers: {},
      data: { totalSize: 1, done: true, records: [{ Id: '001', Name: 'Acme' }] },
    }));
    const out = await runQuery.execute({
      auth,
      http,
      props: { instanceUrl: INSTANCE, query: 'SELECT Id, Name FROM Account LIMIT 1' },
    });
    expect(out.totalSize).toBe(1);
    const url = transport.requests[0]!.url;
    expect(url).toContain(`${BASE}/query?q=`);
    expect(url).toContain('SELECT');
  });
});

describe('salesforce.create_record', () => {
  it('POSTs the fields as the JSON body to /sobjects/{obj}', async () => {
    const { auth, http, transport } = fake(() => ({
      status: 201,
      headers: {},
      data: { id: '001', success: true },
    }));
    const out = await createRecord.execute({
      auth,
      http,
      props: { instanceUrl: INSTANCE, sobject: 'Account', fields: { Name: 'Acme' } },
    });
    expect(out).toEqual({ id: '001', success: true });
    const req = transport.requests[0]!;
    expect(req.url).toBe(`${BASE}/sobjects/Account`);
    expect(req.body).toEqual({ Name: 'Acme' });
  });
});

describe('salesforce.get_record', () => {
  it('GETs the record and passes a fields filter', async () => {
    const { auth, http, transport } = fake(() => ({
      status: 200,
      headers: {},
      data: { Id: '001', Name: 'Acme' },
    }));
    await getRecord.execute({
      auth,
      http,
      props: { instanceUrl: INSTANCE, sobject: 'Account', recordId: '001', fields: 'Id,Name' },
    });
    const url = transport.requests[0]!.url;
    expect(url).toContain(`${BASE}/sobjects/Account/001`);
    expect(url).toContain('fields=Id%2CName');
  });
});

describe('salesforce.update_record', () => {
  it('PATCHes and synthesises a result from the 204 response', async () => {
    const { auth, http, transport } = fake(() => ({ status: 204, headers: {}, data: undefined }));
    const out = await updateRecord.execute({
      auth,
      http,
      props: { instanceUrl: INSTANCE, sobject: 'Account', recordId: '001', fields: { Name: 'New' } },
    });
    expect(out).toEqual({ id: '001', success: true });
    const req = transport.requests[0]!;
    expect(req.method).toBe('PATCH');
    expect(req.body).toEqual({ Name: 'New' });
  });
});

describe('salesforce.delete_record', () => {
  it('DELETEs and synthesises a result from the 204 response', async () => {
    const { auth, http, transport } = fake(() => ({ status: 204, headers: {}, data: undefined }));
    const out = await deleteRecord.execute({
      auth,
      http,
      props: { instanceUrl: INSTANCE, sobject: 'Account', recordId: '001' },
    });
    expect(out).toEqual({ id: '001', success: true });
    expect(transport.requests[0]!.method).toBe('DELETE');
  });
});
