import { HttpClient } from '../../core/http/client';
import type { NormalizedRequest, NormalizedResponse } from '../../core/http/types';
import { FakeTransport, stubAuth } from '../../testing/fakes';
import { buildRawMessage, buildSearchQuery } from './common';
import { listLabels } from './labels';
import { findEmail, getProfile, listMessages, sendEmail } from './messages';

/** Golden offline tests for the Gmail actions, driven by a {@link FakeTransport}. */
function fake(handler: (req: NormalizedRequest, i: number) => NormalizedResponse) {
  const transport = new FakeTransport(handler);
  return { auth: stubAuth(transport, 'oauth2'), http: new HttpClient(), transport };
}

function decodeRaw(raw: string): string {
  return Buffer.from(raw, 'base64url').toString('utf8');
}

describe('buildRawMessage', () => {
  it('assembles RFC822 headers + body and base64url-encodes it', () => {
    const raw = buildRawMessage({ to: 'a@b.com', subject: 'Hi', body: 'Hello there', cc: 'c@d.com' });
    const mime = decodeRaw(raw);
    expect(mime).toContain('To: a@b.com');
    expect(mime).toContain('Cc: c@d.com');
    expect(mime).toContain('Subject: Hi');
    expect(mime).toMatch(/\r\n\r\nHello there$/);
  });
});

describe('gmail.get_profile', () => {
  it('reads /profile', async () => {
    const { auth, http, transport } = fake(() => ({
      status: 200,
      headers: {},
      data: { emailAddress: 'me@x.com', messagesTotal: 10, threadsTotal: 5, historyId: '1' },
    }));
    const out = await getProfile.execute({ auth, http, props: {} });
    expect(out.emailAddress).toBe('me@x.com');
    expect(transport.requests[0]!.url).toBe('https://gmail.googleapis.com/gmail/v1/users/me/profile');
  });
});

describe('gmail.send_email', () => {
  it('sends the message as a base64url raw JSON body', async () => {
    const { auth, http, transport } = fake(() => ({
      status: 200,
      headers: {},
      data: { id: 'm1', threadId: 't1' },
    }));
    await sendEmail.execute({ auth, http, props: { to: 'a@b.com', subject: 'Hi', body: 'yo' } });
    const req = transport.requests[0]!;
    expect(req.url).toBe('https://gmail.googleapis.com/gmail/v1/users/me/messages/send');
    const raw = (req.body as { raw: string }).raw;
    expect(decodeRaw(raw)).toContain('To: a@b.com');
    expect(decodeRaw(raw)).toContain('yo');
  });
});

describe('buildSearchQuery', () => {
  it('composes from/to/subject operators and quotes multi-word values', () => {
    expect(buildSearchQuery({ from: 'boss@x.com', subject: 'Q3 report', query: 'is:unread' })).toBe(
      'from:boss@x.com subject:"Q3 report" is:unread',
    );
    expect(buildSearchQuery({})).toBe('');
  });
});

describe('gmail.gmail_search_mail (find)', () => {
  it('composes the query, passes the label id, and returns refs', async () => {
    const { auth, http, transport } = fake(() => ({
      status: 200,
      headers: {},
      data: { messages: [{ id: 'm1', threadId: 't1' }] },
    }));
    const out = await findEmail.execute({
      auth,
      http,
      props: { from: 'boss@x.com', subject: 'Report', label: 'INBOX', max: 5 },
    });
    expect(out.count).toBe(1);
    expect(out.query).toBe('from:boss@x.com subject:Report');
    const url = transport.requests[0]!.url;
    expect(url).toContain('q=from%3Aboss%40x.com+subject%3AReport');
    expect(url).toContain('labelIds=INBOX');
  });
});

describe('gmail.list_messages', () => {
  it('follows nextPageToken and passes labelIds', async () => {
    const { auth, http, transport } = fake((_req, i) =>
      i === 0
        ? {
            status: 200,
            headers: {},
            data: { messages: [{ id: 'm1', threadId: 't1' }], nextPageToken: 'NP' },
          }
        : { status: 200, headers: {}, data: { messages: [{ id: 'm2', threadId: 't2' }] } },
    );
    const out = await listMessages.execute({ auth, http, props: { labelIds: ['INBOX'], limit: 100 } });
    expect(out.count).toBe(2);
    expect(transport.requests[0]!.url).toContain('labelIds=INBOX');
    expect(transport.requests[1]!.url).toContain('pageToken=NP');
  });
});

describe('gmail.list_labels + label picker', () => {
  it('lists labels and the picker maps name→id', async () => {
    const { auth, http } = fake(() => ({
      status: 200,
      headers: {},
      data: { labels: [{ id: 'INBOX', name: 'INBOX', type: 'system' }] },
    }));
    const out = await listLabels.execute({ auth, http, props: {} });
    expect(out.count).toBe(1);
    const picker = await listMessages.loadOptions('labelIds', { auth, http });
    expect(picker.options[0]).toEqual({ label: 'INBOX', value: 'INBOX' });
  });
});
