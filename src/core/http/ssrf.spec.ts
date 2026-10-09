import { assertPublicUrl, isBlockedIp, preflightTarget } from './ssrf';

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
    ['NAT64 local-use prefix', '64:ff9b:1::a00:1', true],
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

  it('fails closed when the hostname does not resolve', async () => {
    await expect(assertPublicUrl('http://does-not-exist.invalid/')).rejects.toMatchObject({
      code: 'ssrf_blocked',
      message: expect.stringContaining('does not resolve'),
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
