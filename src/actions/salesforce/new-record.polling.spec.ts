import type { NormalizedResponse } from '../../core/http/types';
import { FakeTransport, stubAuth } from '../../testing/fakes';
import { MemoryStore } from '../../testing/memory-store';
import { newRecord } from './new-record.polling';

const PROPS = {
  instanceUrl: 'https://acme.my.salesforce.com',
  apiVersion: 'v58.0',
  sobject: 'Lead',
  fields: 'Name, Company',
};

/** A SOQL `/query` response — shape from Salesforce's public REST docs. */
function queryResponse(): NormalizedResponse {
  return {
    status: 200,
    headers: {},
    data: {
      totalSize: 1,
      done: true,
      records: [
        {
          attributes: {
            type: 'Lead',
            url: '/services/data/v58.0/sobjects/Lead/00Q5f000001abcDEAX',
          },
          Id: '00Q5f000001abcDEAX',
          Name: 'Jane Doe',
          Company: 'Acme',
          CreatedDate: '2024-01-17T19:55:04.000+0000',
        },
      ],
    },
  };
}

/** Read the SOQL back out of the request URL, correctly decoded. */
function soqlOf(url: string): string {
  return new URL(url).searchParams.get('q') ?? '';
}

describe('salesforce.new_record — polling', () => {
  it('builds a CreatedDate since-cursor SOQL query against the REST query endpoint', async () => {
    const transport = new FakeTransport(() => queryResponse());
    await newRecord.runPoll({ auth: stubAuth(transport), props: PROPS, store: new MemoryStore() });

    const sent = transport.requests[0];
    expect(sent?.method).toBe('GET');
    expect(sent?.url.startsWith('https://acme.my.salesforce.com/services/data/v58.0/query')).toBe(true);
    const soql = soqlOf(sent?.url ?? '');
    expect(soql).toContain('SELECT Id, CreatedDate, Name, Company FROM Lead');
    expect(soql).toContain('WHERE CreatedDate > ');
    expect(soql).toContain('ORDER BY CreatedDate ASC');
    // Datetime literal is unquoted ISO-8601 UTC (no single quotes, trailing Z).
    expect(soql).toMatch(/CreatedDate > \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/);
    expect(soql).not.toContain("'");
  });

  it('transforms a real record row into a normalised event (attributes stripped)', async () => {
    const transport = new FakeTransport(() => queryResponse());
    const result = await newRecord.runPoll({
      auth: stubAuth(transport),
      props: PROPS,
      store: new MemoryStore(),
    });

    expect(result.events).toEqual([
      {
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
    ]);
  });

  it('dedupes by record id across polls', async () => {
    const transport = new FakeTransport(() => queryResponse());
    const auth = stubAuth(transport);
    const store = new MemoryStore();

    const first = await newRecord.runPoll({ auth, props: PROPS, store });
    expect(first.events.map((e) => e.id)).toEqual(['00Q5f000001abcDEAX']);

    const second = await newRecord.runPoll({ auth, props: PROPS, store });
    expect(second.events).toEqual([]);
  });

  it('rejects an SObject name that could break out of the SOQL string', async () => {
    const transport = new FakeTransport(() => queryResponse());
    await expect(
      newRecord.runPoll({
        auth: stubAuth(transport),
        props: { ...PROPS, sobject: 'Lead WHERE Id != null OR Name != null' },
        store: new MemoryStore(),
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });
});
