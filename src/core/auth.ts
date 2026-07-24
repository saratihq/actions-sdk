import { ActionError } from './errors';
import type { NormalizedRequest, Transport } from './http/types';

/**
 * The auth seam.
 *
 * An action declares an {@link AuthScheme} — *how* this app authenticates, for
 * the connect UI and the catalog. At run time it is handed an opaque
 * {@link AuthHandle} and passes it straight to `http`. The handle carries the
 * resolved {@link Transport} behind a private symbol, so the action can read the
 * scheme *type* (to branch behaviour if it must) but can never reach the
 * credential or learn where it came from: a BYO pasted key, an OAuth connection,
 * or a host-supplied managed proxy transport all produce the same handle and the
 * action code is byte-identical across them. This lets one action run against a
 * BYO credential or a managed connection with zero branching.
 */

export type AuthSchemeType = 'oauth2' | 'apiKey' | 'basic' | 'none' | 'custom';

/** OAuth2 — the credential is a bearer access token attached as `Authorization: Bearer …`. */
export interface OAuth2Scheme {
  type: 'oauth2';
  /** Connect-UI metadata; not needed to attach the bearer token at runtime. */
  authUrl?: string;
  tokenUrl?: string;
  scopes?: string[];
}

/** API key — attached as a header or a query param, with an optional value prefix. */
export interface ApiKeyScheme {
  type: 'apiKey';
  in: 'header' | 'query';
  /** Header or query-param name, e.g. `Authorization` or `api_key`. */
  name: string;
  /** Value prefix, e.g. `Bearer ` or `token `. Empty by default. */
  prefix?: string;
}

/** HTTP Basic — `Authorization: Basic base64(user:pass)`. */
export interface BasicScheme {
  type: 'basic';
}

/** No authentication (public endpoints). */
export interface NoneScheme {
  type: 'none';
}

/** Escape hatch for signing schemes the declarative kinds don't cover. */
export interface CustomScheme {
  type: 'custom';
  /** Mutates the outbound request to attach the credential. Must not throw for missing creds — return unmodified. */
  apply(request: NormalizedRequest, credential: DirectCredential): void;
}

export type AuthScheme = OAuth2Scheme | ApiKeyScheme | BasicScheme | NoneScheme | CustomScheme;

/**
 * A concrete BYO/direct credential the {@link Transport} attaches. `none` is a
 * first-class case: it lets an action target public data (unauthenticated
 * GitHub reads) through the exact same direct transport, proving the seam
 * spans "has a secret" and "has no secret" without action-code changes.
 */
export type DirectCredential =
  | { type: 'bearer'; token: string }
  | { type: 'apiKey'; value: string }
  | { type: 'basic'; username: string; password: string }
  | { type: 'none' };

/** Private slot: the resolved transport rides here, unreachable from action code. */
const TRANSPORT = Symbol('orchestr.actions.transport');

/**
 * The opaque handle an action holds. Its *public* surface is only the scheme
 * type; the transport is hidden behind {@link TRANSPORT} and is not exported
 * from the package barrel, so action authors cannot read the credential even by
 * accident. `http` retrieves the transport via {@link transportOf}.
 */
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
