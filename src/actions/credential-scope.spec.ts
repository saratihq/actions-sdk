import type { AuthHandle, AuthScheme, DirectCredential } from '../core/auth';
import { createDirectAuth } from '../core/auth-factories';
import { guardedFetch } from '../core/http/guarded-fetch';
import type { FetchLike, FetchLikeResponse } from '../core/http/types';
import { fakeResponse } from '../testing/fakes';
import { type LoopbackServer, startLoopbackServer, withAllowedHosts } from '../testing/loopback-server';
import { MemoryStore } from '../testing/memory-store';
import { calendlyAuth } from './calendly/common';
import { listEventTypes } from './calendly/events';
import { githubTokenAuth, listIssues } from './github/list-issues';
import { jiraAuth } from './jira/common';
import { getIssue } from './jira/issues';
import { mailchimpAuth } from './mailchimp/common';
import { listAudiences } from './mailchimp/lists';
import { outlookAuth } from './outlook/common';
import { newEmail } from './outlook/new-email.polling';
import { salesforceAuth } from './salesforce/common';
import { runQuery } from './salesforce/records';
import { slackOAuth } from './slack/common';
import { getFile } from './slack/get-file';
import { uploadFile } from './slack/upload-file';
import { zendeskAuth } from './zendesk/common';
import { getTicket, listTickets } from './zendesk/tickets';

type Provider = (url: URL, foreign: string) => FetchLikeResponse | null;

interface Case {
  scheme: AuthScheme;
  credential: DirectCredential;
  provider: Provider;
  run: (auth: AuthHandle, foreign: string) => Promise<unknown>;
}

const json = (body: unknown, headers: Record<string, string> = {}): FetchLikeResponse =>
  fakeResponse(200, JSON.stringify(body), { 'content-type': 'application/json', ...headers });

const bearer: DirectCredential = { type: 'bearer', token: 'tok' };
const apiKey: DirectCredential = { type: 'apiKey', value: 'tok' };
const basic: DirectCredential = { type: 'basic', username: 'me@acme.test/token', password: 'tok' };
const nothing: Provider = () => null;

const CASES: Record<string, Case> = {
  'zendesk.list_tickets following next_page': {
    scheme: zendeskAuth,
    credential: basic,
    provider: (url, foreign) =>
      url.hostname === 'acme.zendesk.com'
        ? json({ tickets: [{ id: 1 }], next_page: `${foreign}/api/v2/tickets.json` })
        : null,
    run: (auth) => listTickets.execute({ auth, props: { subdomain: 'acme' } }),
  },
  'calendly.list_event_types following pagination.next_page': {
    scheme: calendlyAuth,
    credential: apiKey,
    provider: (url, foreign) => {
      if (url.hostname !== 'api.calendly.com') return null;
      if (url.pathname === '/users/me')
        return json({ resource: { uri: 'https://api.calendly.com/users/U1' } });
      return json({ collection: [{ uri: 'e1' }], pagination: { next_page: `${foreign}/event_types` } });
    },
    run: (auth) => listEventTypes.execute({ auth, props: {} }),
  },
  'github.list_issues following a Link header': {
    scheme: githubTokenAuth,
    credential: apiKey,
    provider: (url, foreign) =>
      url.hostname === 'api.github.com'
        ? json([{ number: 1, title: 'one' }], { link: `<${foreign}/repos/o/r/issues?page=2>; rel="next"` })
        : null,
    run: (auth) => listIssues.execute({ auth, props: { owner: 'o', repo: 'r' } }),
  },
  'outlook.new_email following @odata.nextLink': {
    scheme: outlookAuth,
    credential: bearer,
    provider: (url, foreign) =>
      url.hostname === 'graph.microsoft.com'
        ? json({ value: [{ id: 'm1' }], '@odata.nextLink': `${foreign}/v1.0/me/messages?$skip=50` })
        : null,
    run: async (auth) => {
      const store = new MemoryStore();
      await store.set('lastPolledAt', '2026-10-01T00:00:00.000Z');
      return newEmail.runPoll({ auth, props: {}, store });
    },
  },
  'slack.get_file downloading url_private_download': {
    scheme: slackOAuth,
    credential: bearer,
    provider: (url, foreign) =>
      url.hostname === 'slack.com'
        ? json({
            ok: true,
            file: { id: 'F1', name: 'a.txt', url_private_download: `${foreign}/files-pri/F1` },
          })
        : null,
    run: (auth) => getFile.execute({ auth, props: { fileId: 'F1' } }),
  },
  'slack.upload_file posting the bytes to upload_url': {
    scheme: slackOAuth,
    credential: bearer,
    provider: (url, foreign) =>
      url.hostname === 'slack.com'
        ? json({ ok: true, upload_url: `${foreign}/upload/v1/x`, file_id: 'F1' })
        : null,
    run: (auth) =>
      uploadFile.execute({
        auth,
        props: { channel: 'C1', file: { filename: 'secret.txt', data: Buffer.from('private bytes') } },
      }),
  },
  'salesforce.run_query at an editor-chosen instanceUrl': {
    scheme: salesforceAuth,
    credential: bearer,
    provider: nothing,
    run: (auth, foreign) =>
      runQuery.execute({ auth, props: { instanceUrl: foreign, query: 'SELECT Id FROM Account' } }),
  },
  'jira.get_issue at an editor-chosen instanceUrl': {
    scheme: jiraAuth,
    credential: basic,
    provider: (url) => (url.hostname === 'api.atlassian.com' ? fakeResponse(401, '') : null),
    run: (auth, foreign) =>
      getIssue.execute({ auth, props: { instanceUrl: foreign, issueIdOrKey: 'ENG-1' } }),
  },
};

/** The provider's own origin answers from `provider`; any other URL rides the real guarded hop to a real socket. */
function authFor(c: Case, foreign: string): AuthHandle {
  const fetchImpl: FetchLike = (input, init) => {
    const canned = c.provider(new URL(String(input)), foreign);
    return canned ? Promise.resolve(canned) : guardedFetch(input, init);
  };
  return createDirectAuth(c.scheme, c.credential, { fetchImpl });
}

describe('a connection credential never reaches an origin its scheme does not declare — real sockets', () => {
  let foreign: LoopbackServer;
  let foreignOrigin: string;

  beforeEach(async () => {
    foreign = await startLoopbackServer((_req, res) => res.end('{"ok":true}'));
    foreignOrigin = `http://127.0.0.1:${foreign.port}`;
  });

  afterEach(() => foreign.close());

  it.each(Object.entries(CASES))('%s is refused before the foreign server is dialled', async (_label, c) => {
    await expect(
      withAllowedHosts('127.0.0.1', () => c.run(authFor(c, foreignOrigin), foreignOrigin)),
    ).rejects.toMatchObject({ code: 'credential_scope' });
    expect(foreign.hits).toHaveLength(0);
  });
});

describe('host-template inputs cannot move the credential to another host', () => {
  const ESCAPES = [
    'evil.com#',
    'evil.com?',
    'a@evil.com/',
    'evil.com\\',
    'evil.com',
    'acme.zendesk.com',
    ' ',
  ];

  it.each(ESCAPES)('zendesk subdomain %j is rejected before any request', async (subdomain) => {
    const fetchImpl = jest.fn<ReturnType<FetchLike>, Parameters<FetchLike>>();
    const auth = createDirectAuth(zendeskAuth, basic, { fetchImpl });
    await expect(getTicket.execute({ auth, props: { subdomain, ticketId: '1' } })).rejects.toMatchObject({
      code: 'invalid_input',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(ESCAPES)('mailchimp serverPrefix %j is rejected before any request', async (serverPrefix) => {
    const fetchImpl = jest.fn<ReturnType<FetchLike>, Parameters<FetchLike>>();
    const auth = createDirectAuth(mailchimpAuth, basic, { fetchImpl });
    await expect(listAudiences.execute({ auth, props: { serverPrefix } })).rejects.toMatchObject({
      code: 'invalid_input',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('a real subdomain and datacenter still reach their provider', async () => {
    const fetchImpl = jest.fn<ReturnType<FetchLike>, Parameters<FetchLike>>(() =>
      Promise.resolve(json({ ticket: { id: 1 }, lists: [] })),
    );
    await getTicket.execute({
      auth: createDirectAuth(zendeskAuth, basic, { fetchImpl }),
      props: { subdomain: 'Acme', ticketId: '1' },
    });
    await listAudiences.execute({
      auth: createDirectAuth(mailchimpAuth, basic, { fetchImpl }),
      props: { serverPrefix: 'us19' },
    });
    expect(fetchImpl.mock.calls.map(([url]) => new URL(String(url)).origin)).toEqual([
      'https://acme.zendesk.com',
      'https://us19.api.mailchimp.com',
    ]);
  });
});
