import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

import { ActionError } from '../errors';

/** IPv4 dotted-quad → 32-bit unsigned int, or null when not a v4 literal. */
function ipv4ToInt(ip: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[2]);
  const c = Number(m[3]);
  const d = Number(m[4]);
  if ([a, b, c, d].some((p) => Number.isNaN(p) || p > 255)) return null;
  return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
}

function ipv4Blocked(n: number): boolean {
  const inRange = (base: string, bits: number): boolean => {
    const b = ipv4ToInt(base) as number;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (n & mask) >>> 0 === (b & mask) >>> 0;
  };
  return (
    inRange('0.0.0.0', 8) || // "this" network
    inRange('10.0.0.0', 8) || // private
    inRange('100.64.0.0', 10) || // carrier-grade NAT
    inRange('127.0.0.0', 8) || // loopback
    inRange('169.254.0.0', 16) || // link-local (incl. 169.254.169.254 cloud metadata)
    inRange('172.16.0.0', 12) || // private
    inRange('192.0.0.0', 24) || // IETF protocol assignments
    inRange('192.168.0.0', 16) || // private
    inRange('198.18.0.0', 15) || // benchmarking
    inRange('240.0.0.0', 4) // reserved (incl. 255.255.255.255 broadcast)
  );
}

/** True iff `ip` (a literal v4 or v6 address) is one we must never fetch. */
export function isBlockedIp(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) {
    const n = ipv4ToInt(ip);
    return n === null ? true : ipv4Blocked(n);
  }
  if (version === 6) {
    const lower = ip.toLowerCase();
    // IPv4-mapped (::ffff:a.b.c.d) — unwrap and apply the v4 rules.
    const mappedV4 = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(lower)?.[1];
    if (mappedV4) return isBlockedIp(mappedV4);
    if (lower === '::1' || lower === '::') return true; // loopback / unspecified
    const first = parseInt(lower.split(':')[0] || '0', 16) || 0;
    if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
    if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    return false;
  }
  return true; // not a parseable IP → block (fail safe)
}

/** Allowed hosts (exact, case-insensitive hostname match) from the environment. */
export function ssrfAllowedHostsFromEnv(): string[] {
  return (process.env.ORCHESTR_HTTP_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

/** Reject `rawUrl` unless http(s) and EVERY address its host resolves to is public; `allowedHosts` bypasses. */
export async function assertPublicUrl(rawUrl: string, opts: { allowedHosts?: string[] } = {}): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ActionError({ code: 'invalid_input', message: `invalid URL: "${rawUrl}"`, retryable: false });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ActionError({
      code: 'ssrf_blocked',
      message: `refusing a non-http(s) URL scheme: ${url.protocol}`,
      retryable: false,
    });
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, ''); // unbracket v6 literals
  if ((opts.allowedHosts ?? []).includes(host)) return;

  let addresses: string[];
  if (isIP(host)) {
    addresses = [host];
  } else {
    try {
      addresses = (await lookup(host, { all: true })).map((a) => a.address);
    } catch {
      // A name with no address reaches no internal service; let the transport surface the DNS error.
      return;
    }
  }
  for (const addr of addresses) {
    if (isBlockedIp(addr)) {
      throw new ActionError({
        code: 'ssrf_blocked',
        message: `refusing to send a request to a private/internal address (${host} → ${addr}). Set ORCHESTR_HTTP_ALLOWED_HOSTS to allow it.`,
        retryable: false,
      });
    }
  }
}

/** The one guard every fully user-controlled outbound URL must go through — validates the INITIAL target only (redirects and DNS rebinding are not re-checked). */
export async function guardUserUrl(url: string): Promise<void> {
  await assertPublicUrl(url, { allowedHosts: ssrfAllowedHostsFromEnv() });
}
