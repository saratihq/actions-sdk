import { type AuthHandle, type AuthScheme, createAuthHandle, type DirectCredential } from './auth';
import { type FetchLike, type Transport } from './http/types';
import { DirectTransport } from './http/transport-direct';

/** Build a handle that sends straight to the provider with a BYO credential (`{ type: 'none' }` for public endpoints); `fetchImpl` replaces the SSRF-guarded hop. */
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

/** Build a handle over a host-supplied {@link Transport} — the managed rail, where the SDK holds no provider secret. */
export function createAuth(scheme: AuthScheme, transport: Transport): AuthHandle {
  return createAuthHandle(scheme.type, transport);
}
