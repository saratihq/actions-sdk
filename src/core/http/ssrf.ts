import { type LookupAddress, lookup as dnsLookup } from 'node:dns';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP, type LookupFunction } from 'node:net';

import { ActionError } from '../errors';

// IANA special-purpose ranges that are not globally reachable.
const NON_PUBLIC_V4: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 3],
];

function sixToFourPrefix(v4: string): string {
  const [a = 0, b = 0, c = 0, d = 0] = v4.split('.').map(Number);
  return `2002:${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}::`;
}

const blockedV4 = new BlockList();
// Mapped, NAT64 and 6to4 addresses carry an IPv4 address and are judged only by it.
const embedsV4 = new BlockList();
const blockedEmbeddedV4 = new BlockList();
const globalUnicastV6 = new BlockList();
// 2001::/23 holds the IETF assignments, Teredo among them.
const nonPublicGlobalV6 = new BlockList();

embedsV4.addSubnet('::ffff:0:0', 96, 'ipv6');
embedsV4.addSubnet('64:ff9b::', 96, 'ipv6');
embedsV4.addSubnet('2002::', 16, 'ipv6');
for (const [base, bits] of NON_PUBLIC_V4) {
  blockedV4.addSubnet(base, bits, 'ipv4');
  blockedEmbeddedV4.addSubnet(`::ffff:${base}`, 96 + bits, 'ipv6');
  blockedEmbeddedV4.addSubnet(`64:ff9b::${base}`, 96 + bits, 'ipv6');
  blockedEmbeddedV4.addSubnet(sixToFourPrefix(base), 16 + bits, 'ipv6');
}
globalUnicastV6.addSubnet('2000::', 3, 'ipv6');
nonPublicGlobalV6.addSubnet('2001::', 23, 'ipv6');
nonPublicGlobalV6.addSubnet('2001:db8::', 32, 'ipv6');
nonPublicGlobalV6.addSubnet('3fff::', 20, 'ipv6');

function isBlockedV6(ip: string): boolean {
  if (embedsV4.check(ip, 'ipv6')) return blockedEmbeddedV4.check(ip, 'ipv6');
  return !globalUnicastV6.check(ip, 'ipv6') || nonPublicGlobalV6.check(ip, 'ipv6');
}

/** True iff `ip` (a literal v4 or v6 address) is one we must never fetch; anything unparseable is blocked. */
export function isBlockedIp(ip: string): boolean {
  try {
    const version = isIP(ip);
    if (version === 4) return blockedV4.check(ip, 'ipv4');
    if (version === 6) return isBlockedV6(ip);
    return true;
  } catch {
    return true;
  }
}

/** Allowed hosts (exact, case-insensitive hostname match) from the environment. */
export function ssrfAllowedHostsFromEnv(): string[] {
  return (process.env.ORCHESTR_HTTP_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

function blockedAddress(host: string, addr: string): ActionError {
  return new ActionError({
    code: 'ssrf_blocked',
    message: `refusing to send a request to a private/internal address (${host} → ${addr}). Set ORCHESTR_HTTP_ALLOWED_HOSTS to allow it.`,
    retryable: false,
  });
}

/** Refuse a non-http(s) URL or a private literal address; returns the hostname still to resolve, or null when none is. */
export function preflightTarget(url: URL, allowedHosts: string[]): string | null {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ActionError({
      code: 'ssrf_blocked',
      message: `refusing a non-http(s) URL scheme: ${url.protocol}`,
      retryable: false,
    });
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (allowedHosts.includes(host)) return null;
  if (!isIP(host)) return host;
  if (isBlockedIp(host)) throw blockedAddress(host, host);
  return null;
}

/** Ahead-of-time check that `rawUrl` is http(s) and EVERY address its host resolves to is public; unresolvable fails closed. */
export async function assertPublicUrl(rawUrl: string, opts: { allowedHosts?: string[] } = {}): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ActionError({ code: 'invalid_input', message: `invalid URL: "${rawUrl}"`, retryable: false });
  }
  const host = preflightTarget(url, opts.allowedHosts ?? []);
  if (host === null) return;
  let addresses: LookupAddress[];
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    addresses = [];
  }
  if (addresses.length === 0) {
    throw new ActionError({
      code: 'ssrf_blocked',
      message: `refusing ${host}: it does not resolve, so it cannot be confirmed as a public address`,
      retryable: false,
    });
  }
  const blocked = addresses.find((a) => isBlockedIp(a.address));
  if (blocked) throw blockedAddress(host, blocked.address);
}

/** Validate a user-supplied URL ahead of time (e.g. on save); requests themselves are re-checked per hop by {@link guardedFetch}. */
export async function guardUserUrl(url: string): Promise<void> {
  await assertPublicUrl(url, { allowedHosts: ssrfAllowedHostsFromEnv() });
}

/** A `net.connect` lookup that refuses a name resolving to any non-public address, so the address checked is the one dialled. */
export const ssrfSafeLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, '', 0);
    if (!ssrfAllowedHostsFromEnv().includes(hostname.toLowerCase())) {
      const blocked = addresses.find((a) => isBlockedIp(a.address));
      if (blocked) return callback(blockedAddress(hostname, blocked.address), '', 0);
    }
    const [first] = addresses;
    if (!first) {
      return callback(Object.assign(new Error(`no address for ${hostname}`), { code: 'ENOTFOUND' }), '', 0);
    }
    return options.all ? callback(null, addresses) : callback(null, first.address, first.family);
  });
};
