import { HttpClient } from '../../core/http/client';
import type { NormalizedRequest, NormalizedResponse } from '../../core/http/types';
import { FakeTransport, stubAuth } from '../../testing/fakes';
import { createContact, listContacts, searchContacts } from './contacts';
import { listAdmins } from './other';

/** Offline harness: a {@link FakeTransport} replays canned REST envelopes and records requests. */
function fake(handler: (req: NormalizedRequest, i: number) => NormalizedResponse) {
  const transport = new FakeTransport(handler);
  return { auth: stubAuth(transport, 'apiKey'), http: new HttpClient(), transport };
}

describe('intercom.list_contacts', () => {
  it('follows the pages.next.starting_after cursor and sends the version header', async () => {
    const { auth, http, transport } = fake((_req, i) =>
      i === 0
        ? {
            status: 200,
            headers: {},
            data: {
              type: 'list',
              data: [{ id: 'c1', role: 'user' }],
              pages: { next: { starting_after: 'AB' } },
            },
          }
        : {
            status: 200,
            headers: {},
            data: { type: 'list', data: [{ id: 'c2', role: 'user' }], pages: { next: null } },
          },
    );
    const out = await listContacts.execute({ auth, http, props: { limit: 50 } });
    expect(out.count).toBe(2);
    expect(transport.requests[0]!.headers['intercom-version']).toBe('2.11');
    expect(transport.requests[1]!.url).toContain('starting_after=AB');
  });
});

describe('intercom.create_contact', () => {
  it('builds the body and maps owner_id + external_id', async () => {
    const { auth, http, transport } = fake(() => ({
      status: 200,
      headers: {},
      data: { id: 'c1', role: 'user', email: 'a@b.com' },
    }));
    const out = await createContact.execute({
      auth,
      http,
      props: { role: 'user', email: 'a@b.com', externalId: 'u42', ownerId: 'admin1' },
    });
    expect(out.id).toBe('c1');
    expect(transport.requests[0]!.body).toEqual({
      role: 'user',
      email: 'a@b.com',
      external_id: 'u42',
      owner_id: 'admin1',
    });
  });
});

describe('intercom.search_contacts', () => {
  it('wraps the field/operator/value into a query body', async () => {
    const { auth, http, transport } = fake(() => ({
      status: 200,
      headers: {},
      data: { type: 'list', data: [] },
    }));
    await searchContacts.execute({ auth, http, props: { field: 'email', operator: '~', value: 'acme' } });
    const req = transport.requests[0]!;
    expect(req.url).toBe('https://api.intercom.io/contacts/search');
    expect(req.body).toEqual({ query: { field: 'email', operator: '~', value: 'acme' } });
  });

  it('passes a raw query object through when given', async () => {
    const { auth, http, transport } = fake(() => ({
      status: 200,
      headers: {},
      data: { type: 'list', data: [] },
    }));
    const raw = { operator: 'AND', value: [{ field: 'role', operator: '=', value: 'lead' }] };
    await searchContacts.execute({ auth, http, props: { query: raw } });
    expect(transport.requests[0]!.body).toEqual({ query: raw });
  });
});

describe('intercom.list_admins + admin picker', () => {
  it('lists admins and the picker maps name/email→id', async () => {
    const { auth, http } = fake(() => ({
      status: 200,
      headers: {},
      data: { admins: [{ id: 'admin1', name: 'Ada', email: 'ada@x.com' }] },
    }));
    const out = await listAdmins.execute({ auth, http, props: {} });
    expect(out.count).toBe(1);
    const picker = await createContact.loadOptions('ownerId', { auth, http });
    expect(picker.options[0]).toEqual({ label: 'Ada', value: 'admin1' });
  });

  it('the admin picker is inert without a connection', async () => {
    const result = await createContact.loadOptions('ownerId', {});
    expect(result.disabled).toBe(true);
  });
});
