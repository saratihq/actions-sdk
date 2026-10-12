import type { AuthHandle, AuthScheme, DirectCredential } from '../core/auth';
import { createAuth, createDirectAuth } from '../core/auth-factories';
import { ActionError } from '../core/errors';
import { HttpClient } from '../core/http/client';
import { guardedFetch } from '../core/http/guarded-fetch';
import type { FetchLike, FetchLikeResponse, NormalizedResponse } from '../core/http/types';
import { FakeTransport, fakeResponse } from '../testing/fakes';
import { type LoopbackServer, startLoopbackServer, withAllowedHosts } from '../testing/loopback-server';
import { MemoryStore } from '../testing/memory-store';
import { calendlyAuth } from './calendly/common';
import { listEventTypes } from './calendly/events';
import { githubTokenAuth, listIssues } from './github/list-issues';
import { jiraAuth } from './jira/common';
import { listComments } from './jira/comments';
import { createIssue, getIssue } from './jira/issues';
import { newIssue } from './jira/new-issue.polling';
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
};

/** The provider's own origin answers from `provider`; any other URL rides the real guarded hop to a real socket. */
function authFor(c: Case, foreign: string, answered: string[]): AuthHandle {
  const fetchImpl: FetchLike = (input, init) => {
    const canned = c.provider(new URL(String(input)), foreign);
    if (!canned) return guardedFetch(input, init);
    answered.push(String(input));
    return Promise.resolve(canned);
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
    const answered: string[] = [];
    await expect(
      withAllowedHosts('127.0.0.1', () => c.run(authFor(c, foreignOrigin, answered), foreignOrigin)),
    ).rejects.toMatchObject({ code: 'credential_scope', message: expect.stringContaining(foreignOrigin) });
    expect(foreign.hits).toHaveLength(0);
    if (c.provider !== nothing) expect(answered.length).toBeGreaterThan(0);
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

describe('instance URLs on each vendor-documented cloud domain are reached; any other host is refused', () => {
  const recorder = (answer: (url: URL) => FetchLikeResponse) => {
    const urls: string[] = [];
    const fetchImpl: FetchLike = (input) => {
      urls.push(String(input));
      return Promise.resolve(answer(new URL(String(input))));
    };
    return { urls, fetchImpl };
  };

  const GATEWAY = 'https://api.atlassian.com';
  const GOV_GATEWAY = 'https://api.atlassian-us-gov-mod.com';

  const brokerWithSites = (sites: Array<{ id: string; url: string }>) =>
    new FakeTransport((req): NormalizedResponse => {
      const path = new URL(req.url).pathname;
      if (path === '/oauth/token/accessible-resources') return { status: 200, headers: {}, data: sites };
      if (path.endsWith('/search/jql')) {
        return { status: 200, headers: {}, data: { issues: [{ id: '10', key: 'ENG-10', fields: {} }] } };
      }
      return { status: 201, headers: {}, data: { id: '10001', key: 'ENG-1' } };
    });
  const issueProps = { project: 'ENG', issueType: 'Task', summary: 's' };

  it.each([
    ['https://acme.atlassian.net', GATEWAY, 'https://acme.atlassian.net'],
    ['https://acme.jira.com', GATEWAY, 'https://acme.jira.com'],
    ['https://acme.atlassian-us-gov-mod.net', GOV_GATEWAY, 'https://acme.atlassian-us-gov-mod.net'],
    ['https://acme.atlassian-us-gov-mod.net/jira', GOV_GATEWAY, 'https://acme.atlassian-us-gov-mod.net'],
    ['https://acme.atlassian.net/browse/ENG-1', GATEWAY, 'https://acme.atlassian.net'],
    ['https://ACME.atlassian.net:443/', GATEWAY, 'https://acme.atlassian.net'],
    ['acme.atlassian.net', GATEWAY, 'https://acme.atlassian.net'],
    ['acme.atlassian.net:443', GATEWAY, 'https://acme.atlassian.net'],
    ['http://acme.atlassian.net', GATEWAY, 'https://acme.atlassian.net'],
    ['https:acme.atlassian.net', GATEWAY, 'https://acme.atlassian.net'],
    ['https:/acme.atlassian.net', GATEWAY, 'https://acme.atlassian.net'],
    ['HTTPS:\\\\acme.atlassian.net', GATEWAY, 'https://acme.atlassian.net'],
    ['http:acme.atlassian.net', GATEWAY, 'https://acme.atlassian.net'],
    ['acme.atlassian-us-gov-mod.net', GOV_GATEWAY, 'https://acme.atlassian-us-gov-mod.net'],
  ] as const)(
    'jira instanceUrl %s: an API-token connection goes straight to the site; a managed one asks %s which site it is',
    async (instanceUrl, gateway, site) => {
      const { urls, fetchImpl } = recorder(() => json({ id: '1', key: 'ENG-1' }));
      await expect(
        getIssue.execute({
          auth: createDirectAuth(jiraAuth, basic, { fetchImpl }),
          props: { instanceUrl, issueIdOrKey: 'ENG-1' },
        }),
      ).resolves.toMatchObject({ key: 'ENG-1' });
      expect(urls).toEqual([`${site}/rest/api/3/issue/ENG-1`]);

      const broker = brokerWithSites([{ id: 'cloud-1', url: site }]);
      await expect(
        getIssue.execute({
          auth: createAuth(jiraAuth, broker),
          props: { instanceUrl, issueIdOrKey: 'ENG-1' },
        }),
      ).resolves.toMatchObject({ key: 'ENG-1' });
      expect(broker.requests.map((r) => r.url)).toEqual([
        `${gateway}/oauth/token/accessible-resources`,
        `${gateway}/ex/jira/cloud-1/rest/api/3/issue/ENG-1`,
      ]);
    },
  );

  const probeFailing = (probe: () => NormalizedResponse) =>
    new FakeTransport((req): NormalizedResponse => {
      if (new URL(req.url).pathname === '/oauth/token/accessible-resources') return probe();
      return { status: 201, headers: {}, data: { id: '10001', key: 'ENG-1' } };
    });

  const noRetry = () => new HttpClient({ retry: { retries: 0 } });

  it('a 429 site lookup with the field blank is a retryable error, not a config error', async () => {
    const broker = probeFailing(() => ({ status: 429, headers: { 'retry-after': '5' }, data: null }));
    await expect(
      createIssue.execute({ auth: createAuth(jiraAuth, broker), props: issueProps, http: noRetry() }),
    ).rejects.toMatchObject({
      code: 'http_error',
      status: 429,
      retryable: true,
      message: "Jira's site lookup failed: HTTP 429",
    });
    expect(broker.requests).toHaveLength(1);
  });

  it('a 503 site lookup with a site set is a retryable error, and nothing is sent to the site', async () => {
    const broker = probeFailing(() => ({ status: 503, headers: {}, data: null }));
    await expect(
      createIssue.execute({
        auth: createAuth(jiraAuth, broker),
        props: { ...issueProps, instanceUrl: 'https://acme.atlassian.net' },
        http: noRetry(),
      }),
    ).rejects.toMatchObject({
      code: 'http_error',
      status: 503,
      retryable: true,
      message: "Jira's site lookup failed: HTTP 503",
    });
    expect(broker.requests.map((r) => new URL(r.url).pathname)).toEqual([
      '/oauth/token/accessible-resources',
    ]);
  });

  it('a site lookup the broker could not reach surfaces its own retryable error', async () => {
    const broker = new FakeTransport(() => {
      throw new ActionError({ code: 'transport_unreachable', message: 'proxy unreachable', retryable: true });
    });
    await expect(
      createIssue.execute({
        auth: createAuth(jiraAuth, broker),
        props: issueProps,
        http: new HttpClient({ retry: { retries: 0 } }),
      }),
    ).rejects.toMatchObject({ code: 'transport_unreachable', retryable: true });
  });

  it.each([
    ['blank', {}],
    ['set', { instanceUrl: 'https://acme.atlassian.net' }],
  ])(
    'a broker transport error carrying status 401 on the site lookup (field %s) is that error, not "cannot list"',
    async (_label, extra) => {
      const broker = new FakeTransport(() => {
        throw new ActionError({
          code: 'transport_unreachable',
          message: 'broker rejected the call',
          status: 401,
          retryable: false,
        });
      });
      await expect(
        createIssue.execute({ auth: createAuth(jiraAuth, broker), props: { ...issueProps, ...extra } }),
      ).rejects.toMatchObject({ code: 'transport_unreachable', status: 401 });
      expect(broker.requests).toHaveLength(1);
    },
  );

  it('a site lookup that 503s once is retried by the client like any other call, and the step resolves', async () => {
    let lookups = 0;
    const broker = new FakeTransport((req): NormalizedResponse => {
      if (new URL(req.url).pathname === '/oauth/token/accessible-resources') {
        lookups += 1;
        return lookups === 1
          ? { status: 503, headers: {}, data: null }
          : { status: 200, headers: {}, data: [{ id: 'cloud-1', url: 'https://acme.atlassian.net' }] };
      }
      return { status: 201, headers: {}, data: { id: '10001', key: 'ENG-1' } };
    });
    await expect(
      createIssue.execute({
        auth: createAuth(jiraAuth, broker),
        props: issueProps,
        http: new HttpClient({ retry: { retries: 1, baseDelayMs: 1, maxDelayMs: 1, jitter: false } }),
      }),
    ).resolves.toEqual({ id: '10001', key: 'ENG-1' });
    expect(broker.requests.map((r) => new URL(r.url).pathname)).toEqual([
      '/oauth/token/accessible-resources',
      '/oauth/token/accessible-resources',
      '/ex/jira/cloud-1/rest/api/3/issue',
    ]);
  });

  it('a site lookup that answers 2xx with something other than a list is a provider error', async () => {
    const broker = probeFailing(() => ({ status: 200, headers: {}, data: '<html>maintenance</html>' }));
    await expect(
      createIssue.execute({ auth: createAuth(jiraAuth, broker), props: issueProps }),
    ).rejects.toMatchObject({
      code: 'provider_error',
      message: "Jira's site lookup returned no list",
    });
    expect(broker.requests).toHaveLength(1);
  });

  it('a broker credential the lookup forbids (403) with a site set falls back to the site itself', async () => {
    const broker = probeFailing(() => ({ status: 403, headers: {}, data: null }));
    await expect(
      createIssue.execute({
        auth: createAuth(jiraAuth, broker),
        props: { ...issueProps, instanceUrl: 'https://acme.atlassian.net' },
      }),
    ).resolves.toEqual({ id: '10001', key: 'ENG-1' });
    expect(broker.requests.map((r) => r.url)).toEqual([
      `${GATEWAY}/oauth/token/accessible-resources`,
      'https://acme.atlassian.net/rest/api/3/issue',
    ]);
  });

  it('a direct OAuth bearer with a site set resolves through its gateway, as a 3LO token must', async () => {
    const { urls, fetchImpl } = recorder((url) =>
      url.pathname === '/oauth/token/accessible-resources'
        ? json([{ id: 'cloud-1', url: 'https://acme.atlassian.net' }])
        : json({ id: '1', key: 'ENG-1' }),
    );
    const auth = createDirectAuth(
      { type: 'oauth2', origins: jiraAuth.origins },
      { type: 'bearer', token: 'tok' },
      { fetchImpl },
    );
    await expect(
      getIssue.execute({ auth, props: { instanceUrl: 'https://acme.atlassian.net', issueIdOrKey: 'ENG-1' } }),
    ).resolves.toMatchObject({ key: 'ENG-1' });
    expect(urls).toEqual([
      `${GATEWAY}/oauth/token/accessible-resources`,
      `${GATEWAY}/ex/jira/cloud-1/rest/api/3/issue/ENG-1`,
    ]);
  });

  it('a broker credential that cannot list sites (401) with a site set falls back to the site itself', async () => {
    const broker = probeFailing(() => ({ status: 401, headers: {}, data: null }));
    await expect(
      createIssue.execute({
        auth: createAuth(jiraAuth, broker),
        props: { ...issueProps, instanceUrl: 'https://acme.atlassian.net' },
      }),
    ).resolves.toEqual({ id: '10001', key: 'ENG-1' });
    expect(broker.requests.map((r) => r.url)).toEqual([
      `${GATEWAY}/oauth/token/accessible-resources`,
      'https://acme.atlassian.net/rest/api/3/issue',
    ]);
  });

  it('a managed connection that reaches no site, with a site set, is refused rather than sent to the bare site', async () => {
    const broker = brokerWithSites([]);
    await expect(
      createIssue.execute({
        auth: createAuth(jiraAuth, broker),
        props: { ...issueProps, instanceUrl: 'https://acme.atlassian.net' },
      }),
    ).rejects.toMatchObject({ code: 'invalid_input', message: 'this connection reaches no Jira site' });
    expect(broker.requests.map((r) => new URL(r.url).pathname)).toEqual([
      '/oauth/token/accessible-resources',
    ]);
  });

  it.each([
    'https://acme.atlassian.net:8443',
    'https://user@acme.atlassian.net',
    'https://acme.atlassian.net.evil.com',
    'https://jira.acme-corp.example',
    'https://atlassian.net',
    'https://agency.atlassian-us-gov-mod.com',
    'https://agency.atlassian-us-gov.net',
    'https://agency.atlassian-gov-mod.net',
    'https://agency.atlassian-us-gov-mod.net.',
    'https://acme.atlassian.net.',
    'https://.atlassian.net',
    'https://..atlassian.net',
    'https://evil.com%2e.atlassian.net',
  ])('jira instanceUrl %j is refused on either rail before any request', async (instanceUrl) => {
    const { urls, fetchImpl } = recorder(() => json([{ id: 'cloud-1', url: 'https://acme.atlassian.net' }]));
    const broker = new FakeTransport(() => ({ status: 200, headers: {}, data: [] }));
    for (const auth of [
      createDirectAuth(
        jiraAuth,
        { type: 'basic', username: 'gov@agency.gov', password: 'GOVTOKEN' },
        { fetchImpl },
      ),
      createAuth(jiraAuth, broker),
    ]) {
      await expect(
        getIssue.execute({ auth, props: { instanceUrl, issueIdOrKey: 'ENG-1' } }),
      ).rejects.toMatchObject({
        code: 'invalid_input',
        detail: { field: 'instanceUrl' },
      });
    }
    expect(urls).toEqual([]);
    expect(broker.requests).toEqual([]);
  });

  it.each([
    ['jira.acme-corp.example', 'has no https:// and is not a Jira Cloud site address'],
    ['acme.atlassian.net:8443', 'has no https:// and is not a Jira Cloud site address'],
    ['https://jira.acme-corp.example', 'is not a Jira Cloud site —'],
    ['https:/jira.acme-corp.example', 'is not a Jira Cloud site —'],
    ['ftp://acme.atlassian.net', 'is not a Jira Cloud site —'],
  ])('jira instanceUrl %j is refused saying what is wrong with it', async (instanceUrl, says) => {
    const { urls, fetchImpl } = recorder(() => json({}));
    await expect(
      getIssue.execute({
        auth: createDirectAuth(jiraAuth, basic, { fetchImpl }),
        props: { instanceUrl, issueIdOrKey: 'ENG-1' },
      }),
    ).rejects.toMatchObject({
      code: 'invalid_input',
      message: expect.stringContaining(`instanceUrl "${instanceUrl}" ${says}`),
    });
    expect(urls).toEqual([]);
  });

  it.each([undefined, '', '   '])(
    'a blank instanceUrl (%j) on an API-token connection is refused before any request',
    async (instanceUrl) => {
      const { urls, fetchImpl } = recorder(() => json({}));
      await expect(
        getIssue.execute({
          auth: createDirectAuth(
            jiraAuth,
            { type: 'basic', username: 'gov@agency.gov', password: 'GOVTOKEN' },
            { fetchImpl },
          ),
          props: { ...(instanceUrl !== undefined ? { instanceUrl } : {}), issueIdOrKey: 'ENG-1' },
        }),
      ).rejects.toMatchObject({ code: 'invalid_input', detail: { field: 'instanceUrl' } });
      expect(urls).toEqual([]);
    },
  );

  it.each([
    ['A1: omitted', {}],
    ['A2: empty', { instanceUrl: '' }],
  ])(
    '%s instanceUrl on a managed connection that reaches one site resolves that site',
    async (_label, extra) => {
      const broker = brokerWithSites([{ id: 'cloud-1', url: 'https://acme.atlassian.net' }]);
      await expect(
        createIssue.execute({ auth: createAuth(jiraAuth, broker), props: { ...issueProps, ...extra } }),
      ).resolves.toEqual({ id: '10001', key: 'ENG-1' });
      expect(broker.requests.map((r) => `${r.method} ${r.url}`)).toEqual([
        `GET ${GATEWAY}/oauth/token/accessible-resources`,
        `POST ${GATEWAY}/ex/jira/cloud-1/rest/api/3/issue`,
      ]);
    },
  );

  it('A3: the new-issue trigger on a managed connection with no instanceUrl polls the single site the token reaches', async () => {
    const broker = brokerWithSites([{ id: 'cloud-1', url: 'https://acme.atlassian.net' }]);
    const store = new MemoryStore();
    await store.set('lastPolledAt', '2026-10-01T00:00:00.000Z');
    const { events } = await newIssue.runPoll({ auth: createAuth(jiraAuth, broker), props: {}, store });
    expect(events.map((e) => e.key)).toEqual(['ENG-10']);
    expect(broker.requests.map((r) => new URL(r.url).pathname)).toEqual([
      '/oauth/token/accessible-resources',
      '/ex/jira/cloud-1/rest/api/3/search/jql',
    ]);
  });

  it('B: a blank instanceUrl on a managed connection that reaches two sites is refused, naming both', async () => {
    const broker = brokerWithSites([
      { id: 'prod-id', url: 'https://acme.atlassian.net' },
      { id: 'sandbox-id', url: 'https://acme-sandbox.atlassian.net' },
    ]);
    await expect(
      createIssue.execute({ auth: createAuth(jiraAuth, broker), props: issueProps }),
    ).rejects.toMatchObject({
      code: 'invalid_input',
      message: expect.stringContaining('https://acme.atlassian.net, https://acme-sandbox.atlassian.net'),
    });
    expect(broker.requests.map((r) => new URL(r.url).pathname)).toEqual([
      '/oauth/token/accessible-resources',
    ]);
  });

  it("an instanceUrl that is none of the managed connection's sites is refused, never sent to another tenant", async () => {
    const broker = brokerWithSites([
      { id: 'prod-id', url: 'https://acme.atlassian.net' },
      { id: 'sandbox-id', url: 'https://acme-sandbox.atlassian.net' },
    ]);
    await expect(
      createIssue.execute({
        auth: createAuth(jiraAuth, broker),
        props: { ...issueProps, instanceUrl: 'https://acme-sandbx.atlassian.net' },
      }),
    ).rejects.toMatchObject({
      code: 'invalid_input',
      message: expect.stringContaining('https://acme.atlassian.net, https://acme-sandbox.atlassian.net'),
    });
    expect(broker.requests.map((r) => new URL(r.url).pathname)).toEqual([
      '/oauth/token/accessible-resources',
    ]);
  });

  it('an empty Jira body where JSON belongs is a provider_error, not a TypeError', async () => {
    const { fetchImpl } = recorder((url) =>
      url.pathname === '/oauth/token/accessible-resources' ? fakeResponse(401, '') : fakeResponse(204, ''),
    );
    const auth = createDirectAuth(jiraAuth, basic, { fetchImpl });
    const instanceUrl = 'https://acme.atlassian.net';
    await expect(
      listComments.execute({ auth, props: { instanceUrl, issueIdOrKey: 'ENG-1' } }),
    ).rejects.toMatchObject({
      code: 'provider_error',
      message: 'Jira returned an empty body where JSON was expected',
    });
    const store = new MemoryStore();
    await store.set('lastPolledAt', '2026-10-01T00:00:00.000Z');
    await expect(newIssue.runPoll({ auth, props: { instanceUrl }, store })).rejects.toMatchObject({
      code: 'provider_error',
    });
  });

  it('a Jira site that answers a web page instead of JSON fails rather than returning the page', async () => {
    const { fetchImpl } = recorder((url) =>
      url.pathname === '/oauth/token/accessible-resources'
        ? fakeResponse(401, '')
        : fakeResponse(200, '<!doctype html><title>Jira</title>', {
            'content-type': 'text/html;charset=UTF-8',
          }),
    );
    await expect(
      getIssue.execute({
        auth: createDirectAuth(jiraAuth, basic, { fetchImpl }),
        props: { instanceUrl: 'https://acme.atlassian.net', issueIdOrKey: 'ENG-1' },
      }),
    ).rejects.toMatchObject({ code: 'provider_error', message: expect.stringContaining('text/html') });
  });

  it.each([
    ['https://acme.my.salesforce.com', true],
    ['https://acme--uat.sandbox.my.salesforce.com', true],
    ['https://acme.my.salesforce.mil', true],
    ['https://acme.my.sfcrmproducts.cn', true],
    ['https://na139.salesforce.com', false],
    ['https://acme.my.site.com', false],
    ['https://acme.lightning.force.com', false],
    ['https://acme.my.salesforce.com.evil.com', false],
  ] as const)('salesforce instanceUrl %s → reached: %s', async (instanceUrl, reached) => {
    const { urls, fetchImpl } = recorder(() => json({ totalSize: 0, done: true, records: [] }));
    const run = runQuery.execute({
      auth: createDirectAuth(salesforceAuth, bearer, { fetchImpl }),
      props: { instanceUrl, query: 'SELECT Id FROM Account' },
    });
    if (reached) {
      await expect(run).resolves.toMatchObject({ done: true });
      expect(new URL(urls[0]!).origin).toBe(instanceUrl);
    } else {
      await expect(run).rejects.toMatchObject({ code: 'credential_scope' });
      expect(urls).toHaveLength(0);
    }
  });
});
