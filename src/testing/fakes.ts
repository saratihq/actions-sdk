import { type AuthHandle, createAuthHandle } from '../core/auth';
import type {
  FetchLike,
  FetchLikeResponse,
  NormalizedRequest,
  NormalizedResponse,
  Transport,
} from '../core/http/types';

/** A {@link Transport} that replays a handler, recording every request it saw. */
export class FakeTransport implements Transport {
  readonly kind = 'fake';
  readonly requests: NormalizedRequest[] = [];

  constructor(
    private readonly handler: (request: NormalizedRequest, callIndex: number) => NormalizedResponse,
  ) {}

  send(request: NormalizedRequest): Promise<NormalizedResponse> {
    const index = this.requests.length;
    this.requests.push(request);
    return Promise.resolve(this.handler(request, index));
  }
}

/** Wrap a transport in an opaque auth handle for tests (scheme label is arbitrary). */
export function stubAuth(transport: Transport, scheme: AuthHandle['scheme'] = 'none'): AuthHandle {
  return createAuthHandle(scheme, transport);
}

/** Build a minimal {@link FetchLikeResponse}. `body` may be text or raw bytes. */
export function fakeResponse(
  status: number,
  body: string | Buffer,
  headers: Record<string, string> = {},
): FetchLikeResponse {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
  return {
    status,
    headers: {
      forEach(cb: (value: string, key: string) => void): void {
        for (const [key, value] of Object.entries(headers)) cb(value, key);
      },
    },
    text: () => Promise.resolve(bytes.toString('utf8')),
    // Copy into a fresh ArrayBuffer (never a slice of Buffer's shared pool).
    arrayBuffer: () => Promise.resolve(new Uint8Array(bytes).buffer),
  };
}

/** A {@link FetchLike} driven by a handler, recording each call. */
export function fakeFetch(
  handler: (input: string | URL, init: Parameters<FetchLike>[1], callIndex: number) => FetchLikeResponse,
): FetchLike & { calls: Array<{ url: string; init: Parameters<FetchLike>[1] }> } {
  const calls: Array<{ url: string; init: Parameters<FetchLike>[1] }> = [];
  const fn = ((input, init) => {
    calls.push({ url: String(input), init });
    return Promise.resolve(handler(input, init, calls.length - 1));
  }) as FetchLike & { calls: typeof calls };
  fn.calls = calls;
  return fn;
}
