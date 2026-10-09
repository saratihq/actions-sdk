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

// In 64:ff9b:1::/96 every other RFC 6052 layout reads the address as 0.0.0.0/8, so only the /96 reading can route.
const NAT64_PREFIXES = ['64:ff9b::', '64:ff9b:1::'];

embedsV4.addSubnet('::ffff:0:0', 96, 'ipv6');
for (const prefix of NAT64_PREFIXES) embedsV4.addSubnet(prefix, 96, 'ipv6');
embedsV4.addSubnet('2002::', 16, 'ipv6');
for (const [base, bits] of NON_PUBLIC_V4) {
  blockedV4.addSubnet(base, bits, 'ipv4');
  blockedEmbeddedV4.addSubnet(`::ffff:${base}`, 96 + bits, 'ipv6');
  for (const prefix of NAT64_PREFIXES) blockedEmbeddedV4.addSubnet(`${prefix}${base}`, 96 + bits, 'ipv6');
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

/** The environment variable naming the hosts an operator lets back past the guard. */
export const SSRF_ALLOWLIST_ENV = 'ORCHESTR_HTTP_ALLOWED_HOSTS';

const warnedEntries = new Set<string>();
let allowlist: { raw: string; hosts: string[] } = { raw: '', hosts: [] };

function warnOnce(entry: string, why: string): void {
  if (warnedEntries.has(entry)) return;
  warnedEntries.add(entry);
  process.emitWarning(`${SSRF_ALLOWLIST_ENV} entry "${entry}" ${why}`, { code: 'SARATI_HTTP_ALLOWED_HOSTS' });
}

function allowlistHost(entry: string): string | null {
  let url: URL;
  try {
    url = new URL(entry.includes('://') ? entry : `http://${isIP(entry) === 6 ? `[${entry}]` : entry}`);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || host.includes('*')) {
    return null;
  }
  if (url.port) warnOnce(entry, `names a port, which is ignored: it allows every port on ${host}`);
  return host;
}

function parseAllowlist(raw: string): string[] {
  const hosts: string[] = [];
  for (const entry of raw
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean)) {
    const host = allowlistHost(entry);
    if (host === null) {
      warnOnce(
        entry,
        'is ignored: list a bare hostname or IP address, not a range, wildcard, path or credentials',
      );
    } else {
      hosts.push(host);
    }
  }
  return hosts;
}

/** Allowed hosts from the environment, normalised the way a URL writes its hostname; an unusable entry is skipped with a one-time warning. */
export function ssrfAllowedHostsFromEnv(): string[] {
  const raw = process.env[SSRF_ALLOWLIST_ENV] ?? '';
  if (raw !== allowlist.raw) allowlist = { raw, hosts: parseAllowlist(raw) };
  return allowlist.hosts;
}

/** The hostname the guard judges and the allowlist matches: lower-cased, IPv6 without brackets. */
export function targetHost(url: URL): string {
  return url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
}

/** The refusal for a non-public target; the resolved address stays out so a refusal cannot map internal names to addresses. */
export function ssrfRefusal(host: string, redirectedFrom?: string): ActionError {
  const via = redirectedFrom ? `, redirected from ${redirectedFrom}` : '';
  return new ActionError({
    code: 'ssrf_blocked',
    message: `refusing to send a request to a private/internal address (${host}${via}). An operator can allow it by adding ${host} to ${SSRF_ALLOWLIST_ENV}.`,
    retryable: false,
  });
}

function unresolvable(host: string, cause?: unknown): ActionError {
  return new ActionError({
    code: 'unresolvable_host',
    message: `${host} does not resolve from this server, so it cannot be confirmed as a public address`,
    retryable: true,
    ...(cause !== undefined ? { cause } : {}),
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
  const host = targetHost(url);
  if (allowedHosts.includes(host)) return null;
  if (!isIP(host)) return host;
  if (isBlockedIp(host)) throw ssrfRefusal(host);
  return null;
}

/** Resolve the target here and refuse it unless every address is public — for a check made before the connection that uses it. */
export async function assertPublicTarget(url: URL, allowedHosts: string[]): Promise<void> {
  const host = preflightTarget(url, allowedHosts);
  if (host === null) return;
  let addresses: LookupAddress[];
  try {
    addresses = await lookup(host, { all: true });
  } catch (err) {
    throw unresolvable(host, err);
  }
  if (addresses.length === 0) throw unresolvable(host);
  if (addresses.some((a) => isBlockedIp(a.address))) throw ssrfRefusal(host);
}

/** Ahead-of-time check that `rawUrl` is http(s) and EVERY address its host resolves to is public; an unresolvable host fails closed. */
export async function assertPublicUrl(rawUrl: string, opts: { allowedHosts?: string[] } = {}): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ActionError({ code: 'invalid_input', message: `invalid URL: "${rawUrl}"`, retryable: false });
  }
  await assertPublicTarget(url, opts.allowedHosts ?? []);
}

/** Validate a user-supplied URL ahead of time (e.g. on save); requests themselves are re-checked per hop by {@link guardedFetch}. */
export async function guardUserUrl(url: string): Promise<void> {
  await assertPublicUrl(url, { allowedHosts: ssrfAllowedHostsFromEnv() });
}

/** A `net.connect` lookup that refuses a name resolving to any non-public address, so the address checked is the one dialled. */
export const ssrfSafeLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, '', 0);
    const allowlisted = ssrfAllowedHostsFromEnv().includes(hostname.toLowerCase());
    if (!allowlisted && addresses.some((a) => isBlockedIp(a.address))) {
      return callback(ssrfRefusal(hostname), '', 0);
    }
    const [first] = addresses;
    if (!first) {
      return callback(Object.assign(new Error(`no address for ${hostname}`), { code: 'ENOTFOUND' }), '', 0);
    }
    return options.all ? callback(null, addresses) : callback(null, first.address, first.family);
  });
};
