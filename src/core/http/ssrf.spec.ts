import { assertPublicUrl, isBlockedIp } from './ssrf';

describe('SSRF guard — isBlockedIp', () => {
  it.each<[string, boolean]>([
    ['127.0.0.1', true],
    ['10.1.2.3', true],
    ['172.16.5.5', true],
    ['192.168.1.1', true],
    ['169.254.169.254', true], // cloud metadata
    ['0.0.0.0', true],
    ['100.64.0.1', true], // CGNAT
    ['::1', true],
    ['fc00::1', true],
    ['fd12::abcd', true],
    ['fe80::1', true],
    ['::ffff:127.0.0.1', true], // IPv4-mapped loopback
    ['8.8.8.8', false],
    ['1.1.1.1', false],
    ['93.184.216.34', false],
    ['2606:4700:4700::1111', false],
  ])('classifies %s as blocked=%s', (ip, blocked) => {
    expect(isBlockedIp(ip)).toBe(blocked);
  });
});

describe('SSRF guard — assertPublicUrl', () => {
  it('allows a public literal IP', async () => {
    await expect(assertPublicUrl('https://8.8.8.8/')).resolves.toBeUndefined();
  });

  it('blocks the cloud-metadata address', async () => {
    await expect(assertPublicUrl('http://169.254.169.254/latest/meta-data/')).rejects.toMatchObject({
      code: 'ssrf_blocked',
    });
  });

  it('blocks a loopback literal', async () => {
    await expect(assertPublicUrl('http://127.0.0.1:8001/api')).rejects.toMatchObject({
      code: 'ssrf_blocked',
    });
  });

  it('blocks a hostname that resolves to loopback (localhost)', async () => {
    await expect(assertPublicUrl('http://localhost/x')).rejects.toMatchObject({ code: 'ssrf_blocked' });
  });

  it('rejects a non-http(s) scheme', async () => {
    await expect(assertPublicUrl('file:///etc/passwd')).rejects.toMatchObject({ code: 'ssrf_blocked' });
  });

  it('honours the opt-in allowlist', async () => {
    await expect(
      assertPublicUrl('http://127.0.0.1:8001/x', { allowedHosts: ['127.0.0.1'] }),
    ).resolves.toBeUndefined();
  });
});
