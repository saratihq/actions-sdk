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
let allowlist: { raw: string; hosts: readonly string[] } = { raw: '', hosts: Object.freeze([]) };

function warnOnce(entry: string, why: string): void {
  if (warnedEntries.has(entry)) return;
  warnedEntries.add(entry);
  process.emitWarning(`${SSRF_ALLOWLIST_ENV} entry "${entry}" ${why}`, { code: 'SARATI_HTTP_ALLOWED_HOSTS' });
}

const NOT_A_HOST =
  'is ignored: list a bare hostname or IP address, not a range, wildcard, path or credentials';
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

// An entry admits every port and scheme on its host, so one naming a port or scheme is refused rather than widened.
function allowlistHost(entry: string): string | null {
  const authority = entry.replace(SCHEME, '');
  let url: URL;
  try {
    url = new URL(`http://${isIP(authority) === 6 ? `[${authority}]` : authority}`);
  } catch {
    warnOnce(entry, NOT_A_HOST);
    return null;
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || /^\.|\*/.test(host)) {
    warnOnce(entry, NOT_A_HOST);
    return null;
  }
  const namesPort = isIP(authority) !== 6 && /:\d*\/?$/.test(authority);
  if (SCHEME.test(entry) || namesPort) {
    warnOnce(
      entry,
      `is ignored: an entry allows every port and scheme on its host; write "${host}" if that is what you mean`,
    );
    return null;
  }
  return host;
}

function parseAllowlist(raw: string): readonly string[] {
  const hosts = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .flatMap((entry) => {
      const host = allowlistHost(entry);
      return host === null ? [] : [host];
    });
  return Object.freeze(hosts);
}

/** The guard's own allowlist, parsed once per value of the environment variable; never handed out mutable. */
export function allowedHosts(): readonly string[] {
  const raw = process.env[SSRF_ALLOWLIST_ENV] ?? '';
  if (raw !== allowlist.raw) allowlist = { raw, hosts: parseAllowlist(raw) };
  return allowlist.hosts;
}

/** Allowed hosts from the environment, normalised the way a URL writes its hostname; an unusable entry is skipped with a one-time warning. */
export function ssrfAllowedHostsFromEnv(): string[] {
  return [...allowedHosts()];
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
    retryable: (cause as { code?: unknown } | undefined)?.code === 'EAI_AGAIN',
    ...(cause !== undefined ? { cause } : {}),
  });
}

/** Refuse a non-http(s) URL or a private literal address; returns the hostname still to resolve, or null when none is. */
export function preflightTarget(url: URL, allowed: readonly string[]): string | null {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ActionError({
      code: 'ssrf_blocked',
      message: `refusing a non-http(s) URL scheme: ${url.protocol}`,
      retryable: false,
    });
  }
  const host = targetHost(url);
  if (allowed.includes(host)) return null;
  if (!isIP(host)) return host;
  if (isBlockedIp(host)) throw ssrfRefusal(host);
  return null;
}

/** Resolve `host` here and return its addresses to dial, IPv4 first, refusing it unless every one is public. */
export async function publicAddresses(host: string): Promise<string[]> {
  let addresses: LookupAddress[];
  try {
    addresses = await lookup(host, { all: true });
  } catch (err) {
    throw unresolvable(host, err);
  }
  if (addresses.length === 0) throw unresolvable(host);
  if (addresses.some((a) => isBlockedIp(a.address))) throw ssrfRefusal(host);
  // Egress proxies reach IPv4 far more reliably than IPv6, so a dual-stack name is tried on IPv4 first.
  return [...addresses].sort((a, b) => Number(b.family === 4) - Number(a.family === 4)).map((a) => a.address);
}

/** Ahead-of-time check that `rawUrl` is http(s) and EVERY address its host resolves to is public; an unresolvable host fails closed. */
export async function assertPublicUrl(rawUrl: string, opts: { allowedHosts?: string[] } = {}): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ActionError({ code: 'invalid_input', message: `invalid URL: "${rawUrl}"`, retryable: false });
  }
  const host = preflightTarget(url, opts.allowedHosts ?? []);
  if (host !== null) await publicAddresses(host);
}

/** Validate a user-supplied URL ahead of time (e.g. on save); requests themselves are re-checked per hop by {@link guardedFetch}. */
export async function guardUserUrl(url: string): Promise<void> {
  await assertPublicUrl(url, { allowedHosts: [...allowedHosts()] });
}

/** A `net.connect` lookup that refuses a name resolving to any non-public address, so the address checked is the one dialled. */
export const ssrfSafeLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, '', 0);
    const allowlisted = allowedHosts().includes(hostname.toLowerCase());
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
