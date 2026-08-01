import { HttpClient } from '../../core/http/client';
import type { NormalizedRequest, NormalizedResponse } from '../../core/http/types';
import { FakeTransport, stubAuth } from '../../testing/fakes';
import { toRecipients } from './common';
import { listFolders } from './folders';
import { getMessage, listMessages, sendEmail } from './messages';

/** Offline harness: a {@link FakeTransport} replays canned Graph responses and records requests. */
function fake(handler: (req: NormalizedRequest, i: number) => NormalizedResponse) {
  const transport = new FakeTransport(handler);
  return { auth: stubAuth(transport, 'oauth2'), http: new HttpClient(), transport };
}

describe('toRecipients', () => {
  it('splits a comma/semicolon list and drops blanks', () => {
    expect(toRecipients('a@b.com, c@d.com; ')).toEqual([
      { emailAddress: { address: 'a@b.com' } },
      { emailAddress: { address: 'c@d.com' } },
    ]);
    expect(toRecipients(undefined)).toEqual([]);
  });
});

describe('outlook.send_email', () => {
  it('POSTs sendMail with the Graph message shape and synthesises a 202 confirmation', async () => {
    const { auth, http, transport } = fake(() => ({ status: 202, headers: {}, data: undefined }));
    const out = await sendEmail.execute({
      auth,
      http,
      props: { to: 'a@b.com, c@d.com', subject: 'Hi', body: 'Hello', cc: 'e@f.com' },
    });
    expect(out).toEqual({ sent: true });
    const req = transport.requests[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('https://graph.microsoft.com/v1.0/me/sendMail');
    expect(req.body).toEqual({
      message: {
        subject: 'Hi',
        body: { contentType: 'Text', content: 'Hello' },
        toRecipients: [{ emailAddress: { address: 'a@b.com' } }, { emailAddress: { address: 'c@d.com' } }],
        ccRecipients: [{ emailAddress: { address: 'e@f.com' } }],
      },
      saveToSentItems: true,
    });
  });

  it('sends an HTML body when requested', async () => {
    const { auth, http, transport } = fake(() => ({ status: 202, headers: {}, data: undefined }));
    await sendEmail.execute({
      auth,
      http,
      props: { to: 'a@b.com', subject: 'S', body: '<b>hi</b>', html: true },
    });
    const message = (transport.requests[0]!.body as { message: { body: { contentType: string } } }).message;
    expect(message.body.contentType).toBe('HTML');
  });
});

describe('outlook.list_messages', () => {
  it('lists all messages (Graph default order, no $orderby) and follows @odata.nextLink', async () => {
    const { auth, http, transport } = fake((_req, i) =>
      i === 0
        ? {
            status: 200,
            headers: {},
            data: {
              value: [{ id: 'm1', subject: 'a' }],
              '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/messages?$skip=50',
            },
          }
        : { status: 200, headers: {}, data: { value: [{ id: 'm2', subject: 'b' }] } },
    );
    const out = await listMessages.execute({ auth, http, props: { limit: 100 } });
    expect(out.count).toBe(2);
    const first = decodeURIComponent(transport.requests[0]!.url);
    expect(first).toContain('$select=');
    expect(first).toContain('$top=50');
    // No $orderby (avoids encoding a spaced OData value); no $search on a plain list.
    expect(first).not.toContain('$orderby');
    expect(first).not.toContain('$search');
    expect(transport.requests[1]!.url).toContain('$skip=50');
  });

  it('uses $search + ConsistencyLevel header and scopes to a folder', async () => {
    const { auth, http, transport } = fake(() => ({ status: 200, headers: {}, data: { value: [] } }));
    await listMessages.execute({ auth, http, props: { folderId: 'inbox', search: 'invoice', limit: 10 } });
    const req = transport.requests[0]!;
    expect(req.url).toContain('https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages');
    expect(decodeURIComponent(req.url)).toContain('$search="invoice"');
    expect(decodeURIComponent(req.url)).not.toContain('$orderby');
    expect(req.headers['consistencylevel']).toBe('eventual');
  });
});

describe('outlook.get_message', () => {
  it('GETs a message by id with the select mask', async () => {
    const { auth, http, transport } = fake(() => ({
      status: 200,
      headers: {},
      data: { id: 'm9', subject: 'Report' },
    }));
    const out = await getMessage.execute({ auth, http, props: { messageId: 'm9' } });
    expect(out.subject).toBe('Report');
    expect(transport.requests[0]!.url).toContain('/me/messages/m9');
    expect(transport.requests[0]!.url).toContain('%24select=');
  });
});

describe('outlook.list_folders', () => {
  it('lists mail folders and follows @odata.nextLink', async () => {
    const { auth, http, transport } = fake((_req, i) =>
      i === 0
        ? {
            status: 200,
            headers: {},
            data: {
              value: [{ id: 'f1', displayName: 'Inbox' }],
              '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/mailFolders?$skip=100',
            },
          }
        : { status: 200, headers: {}, data: { value: [{ id: 'f2', displayName: 'Sent Items' }] } },
    );
    const out = await listFolders.execute({ auth, http, props: { limit: 200 } });
    expect(out.count).toBe(2);
    expect(out.folders[1]!.displayName).toBe('Sent Items');
    expect(transport.requests[1]!.url).toContain('$skip=100');
  });
});
