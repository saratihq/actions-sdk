import type { CredentialOrigins } from '../auth';
import { createAuth } from '../auth-factories';
import { FakeTransport } from '../../testing/fakes';
import { HttpClient } from './client';

const http = new HttpClient({ retry: { retries: 0 } });

function scopedTo(origins: CredentialOrigins): {
  send: (url: string) => Promise<unknown>;
  transport: FakeTransport;
} {
  const transport = new FakeTransport(() => ({ status: 200, headers: {}, data: null }));
  const auth = createAuth({ type: 'oauth2', origins }, transport);
  return { send: (url) => http.get(url, { auth }), transport };
}

describe('credential scope — which URLs a scheme lets its credential ride', () => {
  it.each([
    ['https://slack.com', 'https://slack.com/api/chat.postMessage'],
    ['https://slack.com', 'https://SLACK.com/api'],
    ['https://slack.com:443', 'https://slack.com/api'],
    ['https://*.zendesk.com', 'https://acme.zendesk.com/api/v2/tickets.json'],
    ['https://*.my.salesforce.com', 'https://acme--uat.sandbox.my.salesforce.com/services/data'],
    ['http://127.0.0.1:4010', 'http://127.0.0.1:4010/x'],
  ] as const)('%s admits %s', async (origin, url) => {
    const { send, transport } = scopedTo([origin]);
    await send(url);
    expect(transport.requests.map((r) => r.url)).toEqual([url]);
  });

  it.each([
    ['https://slack.com', 'http://slack.com/api', 'a downgrade to http'],
    ['https://slack.com', 'https://slack.com:8443/api', 'another port'],
    ['https://slack.com', 'https://evil.com/api', 'another host'],
    ['https://slack.com', 'https://slack.com.evil.com/api', 'a suffix-extended host'],
    ['https://slack.com', 'https://slack.com@evil.com/api', 'a userinfo-prefixed host'],
    ['https://*.zendesk.com', 'https://zendesk.com/api', 'the wildcard apex'],
    ['https://*.zendesk.com', 'https://evilzendesk.com/api', 'a lookalike suffix'],
    [
      'https://*.zendesk.com',
      'https://acme.zendesk.com.evil.com/api',
      'a wildcard match buried in another host',
    ],
    ['https://*.zendesk.com', 'https://acme.zendesk.com./api', 'a trailing-dot spelling'],
  ] as const)('%s refuses %s (%s) without sending', async (origin, url, _why) => {
    const { send, transport } = scopedTo([origin]);
    await expect(send(url)).rejects.toMatchObject({ code: 'credential_scope', retryable: false });
    expect(transport.requests).toHaveLength(0);
  });

  it('names the refused origin and the allowed ones', async () => {
    const { send } = scopedTo(['https://slack.com', 'https://files.slack.com']);
    await expect(send('https://evil.com/download?token=x')).rejects.toThrow(
      "refusing to send this connection's credential to https://evil.com — it is only sent to https://slack.com, https://files.slack.com",
    );
  });

  it.each(['slack.com', 'https://*.com', 'https://slack.com/api', 'ftp://slack.com', 'https://Slack.com'])(
    'rejects the malformed origin %s when the handle is built',
    (origin) => {
      expect(() => scopedTo([origin])).toThrow(expect.objectContaining({ code: 'invalid_input' }));
    },
  );

  it('leaves a credential-free scheme unscoped', async () => {
    const transport = new FakeTransport(() => ({ status: 200, headers: {}, data: null }));
    await http.get('https://anywhere.example/x', { auth: createAuth({ type: 'none' }, transport) });
    expect(transport.requests).toHaveLength(1);
  });
});
