import { withAllowedHosts } from '../../testing/loopback-server';
import { assertPublicUrl, isBlockedIp, preflightTarget, ssrfAllowedHostsFromEnv } from './ssrf';

describe('SSRF guard — isBlockedIp', () => {
  it.each<[string, boolean]>([
    ['127.0.0.1', true],
    ['10.1.2.3', true],
    ['172.16.5.5', true],
    ['192.168.1.1', true],
    ['169.254.169.254', true],
    ['0.0.0.0', true],
    ['100.64.0.1', true],
    ['192.0.2.1', true],
    ['224.0.0.1', true],
    ['255.255.255.255', true],
    ['::1', true],
    ['::', true],
    ['fc00::1', true],
    ['fd12::abcd', true],
    ['fe80::1', true],
    ['fe80::1%eth0', true],
    ['fec0::1', true],
    ['ff02::1', true],
    ['8.8.8.8', false],
    ['1.1.1.1', false],
    ['93.184.216.34', false],
    ['2606:4700:4700::1111', false],
    ['2001:4860:4860::8888', false],
    ['not-an-ip', true],
    ['', true],
  ])('classifies %s as blocked=%s', (ip, blocked) => {
    expect(isBlockedIp(ip)).toBe(blocked);
  });

  it.each<[string, string, boolean]>([
    ['IPv4-mapped, dotted', '::ffff:127.0.0.1', true],
    ['IPv4-mapped, hex (what the URL parser emits)', '::ffff:7f00:1', true],
    ['IPv4-mapped cloud metadata, hex', '::ffff:a9fe:a9fe', true],
    ['IPv4-mapped cloud metadata, dotted', '::ffff:169.254.169.254', true],
    ['IPv4-mapped private, fully expanded', '0:0:0:0:0:ffff:0a00:0001', true],
    ['IPv4-mapped public', '::ffff:808:808', false],
    ['IPv4-compatible (deprecated), hex', '::7f00:1', true],
    ['IPv4-compatible (deprecated), dotted', '::127.0.0.1', true],
    ['IPv4-compatible (deprecated), public', '::808:808', true],
    ['IPv4-translated (SIIT)', '::ffff:0:7f00:1', true],
    ['NAT64 loopback', '64:ff9b::7f00:1', true],
    ['NAT64 cloud metadata, dotted', '64:ff9b::169.254.169.254', true],
    ['NAT64 public', '64:ff9b::808:808', false],
    ['NAT64 local-use /96, private', '64:ff9b:1::a00:1', true],
    ['NAT64 local-use /96, public (an IPv6-only DNS64 network)', '64:ff9b:1::5db8:d822', false],
    ['NAT64 local-use /96, cloud metadata, dotted', '64:ff9b:1::169.254.169.254', true],
    ['NAT64 local-use, outside the /96', '64:ff9b:1:1::808:808', true],
    ['6to4 loopback', '2002:7f00:1::', true],
    ['6to4 cloud metadata', '2002:a9fe:a9fe::1', true],
    ['6to4 private', '2002:a00:1::1', true],
    ['6to4 public', '2002:808:808::1', false],
    ['Teredo', '2001:0:4136:e378:8000:63bf:3fff:fdd2', true],
    ['documentation', '2001:db8::1', true],
    ['documentation (RFC 9637)', '3fff::1', true],
  ])('%s: %s blocked=%s', (_form, ip, blocked) => {
    expect(isBlockedIp(ip)).toBe(blocked);
  });
});

describe('SSRF guard — preflightTarget', () => {
  it('returns a hostname for the connect-time check and nothing for a public literal', () => {
    expect(preflightTarget(new URL('https://Example.COM/x'), [])).toBe('example.com');
    expect(preflightTarget(new URL('https://8.8.8.8/'), [])).toBeNull();
    expect(preflightTarget(new URL('https://[2606:4700:4700::1111]/'), [])).toBeNull();
  });

  it('skips an allowlisted host entirely', () => {
    expect(preflightTarget(new URL('http://127.0.0.1:8001/'), ['127.0.0.1'])).toBeNull();
    expect(preflightTarget(new URL('http://internal.corp/'), ['internal.corp'])).toBeNull();
  });
});

describe('SSRF guard — assertPublicUrl', () => {
  it('allows a public literal IP', async () => {
    await expect(assertPublicUrl('https://8.8.8.8/')).resolves.toBeUndefined();
  });

  it.each([
    'http://169.254.169.254/latest/meta-data/',
    'http://127.0.0.1:8001/api',
    'http://[::ffff:169.254.169.254]/latest/meta-data',
    'http://[::ffff:127.0.0.1]:8001/',
    'http://[::ffff:a9fe:a9fe]/',
    'http://[::127.0.0.1]/',
    'http://[::ffff:0:127.0.0.1]/',
    'http://[64:ff9b::169.254.169.254]/',
    'http://[2002:a9fe:a9fe::]/',
    'http://[2001:0:4136:e378:8000:63bf:3fff:fdd2]/',
    'http://[::1]/',
    'http://0x7f.1/',
    'http://2130706433/',
    'http://017700000001/',
  ])('blocks %s', async (url) => {
    await expect(assertPublicUrl(url)).rejects.toMatchObject({ code: 'ssrf_blocked' });
  });

  it('blocks a hostname that resolves to loopback (localhost)', async () => {
    await expect(assertPublicUrl('http://localhost/x')).rejects.toMatchObject({ code: 'ssrf_blocked' });
  });

  it('fails closed when the hostname does not resolve, with its own code', async () => {
    await expect(assertPublicUrl('http://does-not-exist.invalid/')).rejects.toMatchObject({
      code: 'unresolvable_host',
      message: expect.stringContaining('does-not-exist.invalid does not resolve'),
    });
  });

  it('names the host and the allowlist entry that would let it in', async () => {
    await expect(assertPublicUrl('http://localhost/x')).rejects.toMatchObject({
      message:
        'refusing to send a request to a private/internal address (localhost). An operator can allow it by adding localhost to ORCHESTR_HTTP_ALLOWED_HOSTS.',
    });
  });

  it('rejects a non-http(s) scheme', async () => {
    await expect(assertPublicUrl('file:///etc/passwd')).rejects.toMatchObject({ code: 'ssrf_blocked' });
  });

  it('rejects an unparseable URL', async () => {
    await expect(assertPublicUrl('not a url')).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('honours the opt-in allowlist', async () => {
    await expect(
      assertPublicUrl('http://127.0.0.1:8001/x', { allowedHosts: ['127.0.0.1'] }),
    ).resolves.toBeUndefined();
  });

  it('matches the allowlist exactly, so another spelling of an allowed address is still refused', async () => {
    await expect(
      assertPublicUrl('http://[::ffff:127.0.0.1]:8001/x', { allowedHosts: ['127.0.0.1'] }),
    ).rejects.toMatchObject({ code: 'ssrf_blocked' });
  });
});

describe('SSRF guard — ssrfAllowedHostsFromEnv', () => {
  it('normalises entries the way a URL writes its hostname, and warns once about each unusable one', async () => {
    const warn = jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    try {
      const raw =
        ' http://Example.COM:8080/ , [::1], 0:0:0:0:0:0:0:1, localhost:3000, 127.1, ::FFFF:127.0.0.1, 192.168.1.0/24, *.corp, user:pw@host ';
      const hosts = await withAllowedHosts(raw, () => Promise.resolve(ssrfAllowedHostsFromEnv()));
      expect(hosts).toEqual(['example.com', '::1', '::1', 'localhost', '127.0.0.1', '::ffff:7f00:1']);
      const warned = warn.mock.calls.map(([message]) => String(message));
      expect(warned).toEqual([
        'ORCHESTR_HTTP_ALLOWED_HOSTS entry "http://Example.COM:8080/" names a port, which is ignored: it allows every port on example.com',
        'ORCHESTR_HTTP_ALLOWED_HOSTS entry "localhost:3000" names a port, which is ignored: it allows every port on localhost',
        'ORCHESTR_HTTP_ALLOWED_HOSTS entry "192.168.1.0/24" is ignored: list a bare hostname or IP address, not a range, wildcard, path or credentials',
        'ORCHESTR_HTTP_ALLOWED_HOSTS entry "*.corp" is ignored: list a bare hostname or IP address, not a range, wildcard, path or credentials',
        'ORCHESTR_HTTP_ALLOWED_HOSTS entry "user:pw@host" is ignored: list a bare hostname or IP address, not a range, wildcard, path or credentials',
      ]);
      await withAllowedHosts(`${raw},`, () => Promise.resolve(ssrfAllowedHostsFromEnv()));
      expect(warn).toHaveBeenCalledTimes(5);
    } finally {
      warn.mockRestore();
    }
  });

  it('lets a bracketed IPv6 entry match its URL', () => {
    return withAllowedHosts('[::1]', () => {
      expect(preflightTarget(new URL('http://[::1]:9/'), ssrfAllowedHostsFromEnv())).toBeNull();
      return Promise.resolve();
    });
  });
});
