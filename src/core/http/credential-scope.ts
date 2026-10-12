import { type AuthHandle, type AuthScheme, createAuthHandle, transportOf } from '../auth';
import { ActionError } from '../errors';
import type { NormalizedRequest, NormalizedResponse, Transport } from './types';

interface OriginRule {
  protocol: string;
  host: string;
  anySubdomain: boolean;
  port: string;
}

const ORIGIN_PATTERN = /^(https?:)\/\/(\*\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)*)(?::(\d{1,5}))?$/;
const DEFAULT_PORTS: Record<string, string> = { 'http:': '80', 'https:': '443' };

function toRule(origin: string): OriginRule {
  const [, protocol = '', wildcard, host = '', port] = ORIGIN_PATTERN.exec(origin) ?? [];
  if (!protocol || (wildcard !== undefined && !host.includes('.'))) {
    throw new ActionError({
      code: 'invalid_input',
      message: `invalid credential origin "${origin}" — expected e.g. https://api.example.com or https://*.example.com`,
      retryable: false,
    });
  }
  return {
    protocol,
    host,
    anySubdomain: wildcard !== undefined,
    port: port === undefined || port === DEFAULT_PORTS[protocol] ? '' : port,
  };
}

function allows(rule: OriginRule, url: URL): boolean {
  if (url.protocol !== rule.protocol || url.port !== rule.port) return false;
  return rule.anySubdomain ? url.hostname.endsWith(`.${rule.host}`) : url.hostname === rule.host;
}

/** The origins one scheme's credential may reach; `admit` parses a URL and refuses any other origin. */
export class CredentialScope {
  private readonly origins: readonly string[];
  private readonly rules: OriginRule[];

  constructor(scheme: Exclude<AuthScheme, { type: 'none' }>) {
    const origins: unknown = scheme.origins;
    if (!Array.isArray(origins) || origins.length === 0) {
      throw new ActionError({
        code: 'invalid_input',
        message: `a ${scheme.type} scheme must declare the origins its credential may reach, e.g. origins: ['https://api.example.com']`,
        retryable: false,
      });
    }
    this.origins = origins as string[];
    this.rules = this.origins.map(toRule);
  }

  /** The parsed URL to send, or `credential_scope` when it is outside the declared origins. */
  admit(rawUrl: string): URL {
    let target: URL;
    try {
      target = new URL(rawUrl);
    } catch {
      throw new ActionError({ code: 'invalid_input', message: 'invalid request URL', retryable: false });
    }
    if (!this.rules.some((rule) => allows(rule, target))) {
      throw new ActionError({
        code: 'credential_scope',
        message: `refusing to send this connection's credential to ${target.origin} — it is only sent to ${this.origins.join(', ')}`,
        retryable: false,
      });
    }
    return target;
  }
}

/** The scope a scheme's credential is held to, or `null` for a credential-free scheme; throws on a malformed origin. */
export function credentialScope(scheme: AuthScheme): CredentialScope | null {
  return scheme.type === 'none' ? null : new CredentialScope(scheme);
}

function scoped(scope: CredentialScope | null, transport: Transport): Transport {
  if (!scope) return transport;
  return {
    kind: transport.kind,
    async send(request: NormalizedRequest): Promise<NormalizedResponse> {
      return transport.send({ ...request, url: scope.admit(request.url).href });
    },
  };
}

/** Wrap `transport` so a request outside the scheme's origins fails before it is sent, and the checked URL is the one sent. */
export function scopeCredential(scheme: AuthScheme, transport: Transport): Transport {
  return scoped(credentialScope(scheme), transport);
}

/** Re-wrap `auth` so whatever transport it carries only reaches the origins `scope` allows. */
export function scopeHandle(scope: CredentialScope | null, auth: AuthHandle): AuthHandle {
  return scope ? createAuthHandle(auth.scheme, scoped(scope, transportOf(auth))) : auth;
}
