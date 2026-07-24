import { type AuthHandle, type AuthScheme, createAuthHandle, type DirectCredential } from './auth';
import { type FetchLike, type Transport } from './http/types';
import { DirectTransport } from './http/transport-direct';

/**
 * Runtime seam: the SDK ships two ways to build the opaque {@link AuthHandle} an
 * action runs on. Which one the runtime picks — BYO/direct or managed via a
 * host-supplied proxy transport — is invisible to the action.
 */

/**
 * Build a handle that sends straight to the provider with a BYO credential
 * (self-host / pasted key / an OAuth token). Pass a `{ type: 'none' }`
 * credential to hit public endpoints unauthenticated through the same rail.
 */
export function createDirectAuth(
  scheme: AuthScheme,
  credential: DirectCredential,
  options: { fetchImpl?: FetchLike } = {},
): AuthHandle {
  const transport = new DirectTransport({
    scheme,
    credential,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
  return createAuthHandle(scheme.type, transport);
}

/**
 * Build a handle over an arbitrary, host-supplied {@link Transport} — the
 * vendor-neutral managed rail. The runtime pairs its own proxy transport (which
 * attaches the real credential server-side, so the SDK holds no provider secret)
 * with the action's declared {@link AuthScheme}; the scheme type is surfaced on
 * the handle for the catalog/UI, but the action never reads it.
 */
export function createAuth(scheme: AuthScheme, transport: Transport): AuthHandle {
  return createAuthHandle(scheme.type, transport);
}
