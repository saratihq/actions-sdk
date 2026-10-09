import type { AuthScheme } from '../auth';
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

function outOfScope(rules: OriginRule[], origins: readonly string[], rawUrl: string): ActionError | null {
  let target: URL;
  try {
    target = new URL(rawUrl);
  } catch {
    return new ActionError({ code: 'invalid_input', message: 'invalid request URL', retryable: false });
  }
  if (rules.some((rule) => allows(rule, target))) return null;
  return new ActionError({
    code: 'credential_scope',
    message: `refusing to send this connection's credential to ${target.origin} — it is only sent to ${origins.join(', ')}`,
    retryable: false,
  });
}

/** Wrap `transport` so a request outside the scheme's declared origins fails before it is sent. */
export function scopeCredential(scheme: AuthScheme, transport: Transport): Transport {
  if (scheme.type === 'none') return transport;
  const { origins } = scheme;
  const rules = origins.map(toRule);
  return {
    kind: transport.kind,
    send(request: NormalizedRequest): Promise<NormalizedResponse> {
      const refusal = outOfScope(rules, origins, request.url);
      return refusal ? Promise.reject(refusal) : transport.send(request);
    },
  };
}
