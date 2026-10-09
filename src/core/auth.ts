import { ActionError } from './errors';
import type { NormalizedRequest, Transport } from './http/types';

export type AuthSchemeType = 'oauth2' | 'apiKey' | 'basic' | 'none' | 'custom';

/** Where a scheme's credential may be sent: exact origins (`https://slack.com`) or `https://*.zendesk.com` for any subdomain. */
export type CredentialOrigins = readonly [string, ...string[]];

/** OAuth2 — the credential is a bearer access token attached as `Authorization: Bearer …`. */
export interface OAuth2Scheme {
  type: 'oauth2';
  origins: CredentialOrigins;
  /** Connect-UI metadata; not needed to attach the bearer token at runtime. */
  authUrl?: string;
  tokenUrl?: string;
  scopes?: string[];
}

/** API key — attached as a header or a query param, with an optional value prefix. */
export interface ApiKeyScheme {
  type: 'apiKey';
  origins: CredentialOrigins;
  in: 'header' | 'query';
  /** Header or query-param name, e.g. `Authorization` or `api_key`. */
  name: string;
  /** Value prefix, e.g. `Bearer ` or `token `. Empty by default. */
  prefix?: string;
}

/** HTTP Basic — `Authorization: Basic base64(user:pass)`. */
export interface BasicScheme {
  type: 'basic';
  origins: CredentialOrigins;
}

/** No authentication (public endpoints). */
export interface NoneScheme {
  type: 'none';
}

/** Escape hatch for signing schemes the declarative kinds don't cover. */
export interface CustomScheme {
  type: 'custom';
  origins: CredentialOrigins;
  /** Mutates the outbound request to attach the credential. Must not throw for missing creds — return unmodified. */
  apply(request: NormalizedRequest, credential: DirectCredential): void;
}

export type AuthScheme = OAuth2Scheme | ApiKeyScheme | BasicScheme | NoneScheme | CustomScheme;

/** A concrete BYO/direct credential the {@link Transport} attaches; `none` is a first-class case. */
export type DirectCredential =
  | { type: 'bearer'; token: string }
  | { type: 'apiKey'; value: string }
  | { type: 'basic'; username: string; password: string }
  | { type: 'none' };

/** Private slot: the resolved transport rides here, unreachable from action code. */
const TRANSPORT = Symbol('orchestr.actions.transport');

/** The opaque handle an action holds; its only public surface is the scheme type — the transport stays hidden. */
export interface AuthHandle {
  readonly scheme: AuthSchemeType;
}

interface InternalAuthHandle extends AuthHandle {
  readonly [TRANSPORT]: Transport;
}

/** Pair a scheme type with a resolved transport into a handle. Runtime/harness use only. */
export function createAuthHandle(scheme: AuthSchemeType, transport: Transport): AuthHandle {
  const handle: InternalAuthHandle = { scheme, [TRANSPORT]: transport };
  return handle;
}

/** Retrieve the transport a handle was built with. Throws if a raw object is passed by mistake. */
export function transportOf(auth: AuthHandle): Transport {
  const transport = (auth as Partial<InternalAuthHandle>)[TRANSPORT];
  if (!transport) {
    throw new ActionError({
      code: 'auth_missing',
      message: 'auth handle has no transport — build it with createDirectAuth/createAuth',
      retryable: false,
    });
  }
  return transport;
}
