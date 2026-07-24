import { HttpClient } from '../../core/http/client';
import type { NormalizedRequest, NormalizedResponse } from '../../core/http/types';
import { FakeTransport, stubAuth } from '../../testing/fakes';
import { subscriberHash } from './common';
import { listAudiences } from './lists';
import { addMember, getMember, updateMember } from './members';

/**
 * Golden offline tests for the Mailchimp actions. A {@link FakeTransport} replays
 * canned responses and records requests, asserting the datacenter-prefixed host,
 * JSON write bodies, and the MD5 subscriber-hash addressing without a connection.
 */
const DC = 'us19';
const BASE = `https://${DC}.api.mailchimp.com/3.0`;

function fake(handler: (req: NormalizedRequest) => NormalizedResponse) {
  const transport = new FakeTransport(handler);
  return { auth: stubAuth(transport, 'basic'), http: new HttpClient(), transport };
}

describe('subscriberHash', () => {
  it('is the MD5 of the lowercased email', () => {
    // Well-known MD5 of "test@example.com".
    expect(subscriberHash('Test@Example.com')).toBe('55502f40dc8b7c769880b10874abc9d0');
  });
});

describe('mailchimp.list_audiences', () => {
  it('reads /lists on the datacenter host', async () => {
    const { auth, http, transport } = fake(() => ({
      status: 200,
      headers: {},
      data: { lists: [{ id: 'l1', name: 'Newsletter' }], total_items: 1 },
    }));
    const out = await listAudiences.execute({ auth, http, props: { serverPrefix: DC } });
    expect(out.count).toBe(1);
    expect(transport.requests[0]!.url).toContain(`${BASE}/lists`);
  });
});

describe('mailchimp.add_member', () => {
  it('POSTs email_address + status to the list members endpoint', async () => {
    const { auth, http, transport } = fake(() => ({
      status: 200,
      headers: {},
      data: { id: 'm1', email_address: 'a@b.com', status: 'subscribed' },
    }));
    await addMember.execute({
      auth,
      http,
      props: { serverPrefix: DC, listId: 'l1', email: 'a@b.com', mergeFields: { FNAME: 'Ada' } },
    });
    const req = transport.requests[0]!;
    expect(req.url).toBe(`${BASE}/lists/l1/members`);
    expect(req.body).toEqual({
      email_address: 'a@b.com',
      status: 'subscribed',
      merge_fields: { FNAME: 'Ada' },
    });
  });
});

describe('mailchimp.get_member', () => {
  it('addresses the member by MD5 subscriber hash', async () => {
    const { auth, http, transport } = fake(() => ({
      status: 200,
      headers: {},
      data: { id: 'm1', email_address: 'test@example.com', status: 'subscribed' },
    }));
    await getMember.execute({
      auth,
      http,
      props: { serverPrefix: DC, listId: 'l1', email: 'test@example.com' },
    });
    expect(transport.requests[0]!.url).toBe(`${BASE}/lists/l1/members/55502f40dc8b7c769880b10874abc9d0`);
  });
});

describe('mailchimp.update_member', () => {
  it('PATCHes only supplied fields', async () => {
    const { auth, http, transport } = fake(() => ({
      status: 200,
      headers: {},
      data: { id: 'm1', email_address: 'a@b.com', status: 'unsubscribed' },
    }));
    await updateMember.execute({
      auth,
      http,
      props: { serverPrefix: DC, listId: 'l1', email: 'a@b.com', status: 'unsubscribed' },
    });
    const req = transport.requests[0]!;
    expect(req.method).toBe('PATCH');
    expect(req.body).toEqual({ status: 'unsubscribed' });
  });
});
