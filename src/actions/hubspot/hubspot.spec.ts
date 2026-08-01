import { HttpClient } from '../../core/http/client';
import type { NormalizedRequest, NormalizedResponse } from '../../core/http/types';
import { FakeTransport, stubAuth } from '../../testing/fakes';
import { createContact, listContacts, searchContacts } from './contacts';
import { createDeal } from './deals';
import { listOwners } from './owners';

/** Golden offline tests for the HubSpot actions, driven by a {@link FakeTransport}. */
const CONTACTS = 'https://api.hubapi.com/crm/v3/objects/contacts';

function fake(handler: (req: NormalizedRequest, i: number) => NormalizedResponse) {
  const transport = new FakeTransport(handler);
  return { auth: stubAuth(transport, 'apiKey'), http: new HttpClient(), transport };
}

describe('hubspot.create_contact', () => {
  it('maps discrete props + owner into a properties body', async () => {
    const { auth, http, transport } = fake(() => ({
      status: 201,
      headers: {},
      data: { id: '1', properties: { email: 'a@b.com' } },
    }));
    const out = await createContact.execute({
      auth,
      http,
      props: {
        email: 'a@b.com',
        firstname: 'Ada',
        ownerId: 'own1',
        additionalProperties: { lifecyclestage: 'lead' },
      },
    });
    expect(out.id).toBe('1');
    expect(transport.requests[0]!.url).toBe(CONTACTS);
    expect(transport.requests[0]!.body).toEqual({
      properties: { email: 'a@b.com', firstname: 'Ada', hubspot_owner_id: 'own1', lifecyclestage: 'lead' },
    });
  });
});

describe('hubspot.list_contacts', () => {
  it('follows the paging.next.after cursor', async () => {
    const { auth, http, transport } = fake((_req, i) =>
      i === 0
        ? {
            status: 200,
            headers: {},
            data: { results: [{ id: '1', properties: {} }], paging: { next: { after: '25' } } },
          }
        : { status: 200, headers: {}, data: { results: [{ id: '2', properties: {} }] } },
    );
    const out = await listContacts.execute({ auth, http, props: { limit: 100 } });
    expect(out.count).toBe(2);
    expect(transport.requests[1]!.url).toContain('after=25');
  });
});

describe('hubspot.search_contacts', () => {
  it('builds a filterGroups body from a property filter', async () => {
    const { auth, http, transport } = fake(() => ({
      status: 200,
      headers: {},
      data: { results: [], total: 0 },
    }));
    await searchContacts.execute({
      auth,
      http,
      props: { propertyName: 'email', operator: 'EQ', value: 'a@b.com', limit: 10 },
    });
    const req = transport.requests[0]!;
    expect(req.url).toBe(`${CONTACTS}/search`);
    expect(req.body).toEqual({
      limit: 10,
      filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: 'a@b.com' }] }],
    });
  });

  it('follows the paging.next.after cursor across pages up to the limit', async () => {
    const { auth, http, transport } = fake((_req, i) =>
      i === 0
        ? {
            status: 200,
            headers: {},
            data: { results: [{ id: '1', properties: {} }], total: 2, paging: { next: { after: '1' } } },
          }
        : { status: 200, headers: {}, data: { results: [{ id: '2', properties: {} }], total: 2 } },
    );
    const out = await searchContacts.execute({ auth, http, props: { query: 'ada', limit: 100 } });
    expect(out.count).toBe(2);
    expect(out.total).toBe(2);
    // The second page carries the first page's after cursor in the POST body.
    expect((transport.requests[1]!.body as { after?: string }).after).toBe('1');
  });
});

describe('hubspot.create_deal + pipeline picker', () => {
  it('maps discrete props into a properties body (closeDate→closedate)', async () => {
    const { auth, http, transport } = fake(() => ({
      status: 201,
      headers: {},
      data: { id: 'd1', properties: { dealname: 'Big one' } },
    }));
    const out = await createDeal.execute({
      auth,
      http,
      props: {
        dealname: 'Big one',
        pipeline: 'default',
        dealstage: 'appointmentscheduled',
        amount: '5000',
        closeDate: '2026-08-01T00:00:00Z',
        ownerId: 'own1',
        additionalProperties: { hs_priority: 'high' },
      },
    });
    expect(out.id).toBe('d1');
    expect(transport.requests[0]!.url).toBe('https://api.hubapi.com/crm/v3/objects/deals');
    expect(transport.requests[0]!.body).toEqual({
      properties: {
        dealname: 'Big one',
        pipeline: 'default',
        dealstage: 'appointmentscheduled',
        amount: '5000',
        closedate: '2026-08-01T00:00:00Z',
        hubspot_owner_id: 'own1',
        hs_priority: 'high',
      },
    });
  });

  it('the pipeline picker maps label→id, and is inert without a connection', async () => {
    const { auth, http } = fake(() => ({
      status: 200,
      headers: {},
      data: { results: [{ id: 'default', label: 'Sales Pipeline' }] },
    }));
    const picker = await createDeal.loadOptions('pipeline', { auth, http });
    expect(picker.options[0]).toEqual({ label: 'Sales Pipeline', value: 'default' });
    expect((await createDeal.loadOptions('pipeline', {})).disabled).toBe(true);
  });
});

describe('hubspot.list_owners + owner picker', () => {
  it('lists owners and the picker maps a display name→id', async () => {
    const { auth, http } = fake(() => ({
      status: 200,
      headers: {},
      data: { results: [{ id: 'own1', email: 'ada@x.com', firstName: 'Ada', lastName: 'L' }] },
    }));
    const out = await listOwners.execute({ auth, http, props: {} });
    expect(out.count).toBe(1);
    const picker = await createContact.loadOptions('ownerId', { auth, http });
    expect(picker.options[0]).toEqual({ label: 'Ada L', value: 'own1' });
  });

  it('the owner picker is inert without a connection', async () => {
    const result = await createContact.loadOptions('ownerId', {});
    expect(result.disabled).toBe(true);
  });
});
