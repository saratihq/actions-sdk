import type { AuthScheme, DirectCredential } from '../auth';
import { ActionError } from '../errors';
import { encodeForm } from './form';
import { encodeMultipart } from './multipart';
import {
  appendQuery,
  type FetchLike,
  isFormBody,
  isMultipartBody,
  type NormalizedRequest,
  type NormalizedResponse,
  resolveFetch,
  type Transport,
} from './types';

export interface DirectTransportOptions {
  scheme: AuthScheme;
  credential: DirectCredential;
  /** Inject a fetch for testing; defaults to the global. */
  fetchImpl?: FetchLike;
}

/**
 * Sends requests straight to the provider, attaching the BYO credential per the
 * declared {@link AuthScheme}. This is the self-host / bring-your-own-key rail:
 * no proxy, near-zero marginal cost. It returns non-2xx responses rather than
 * throwing — retry/error decisions belong to the client, uniformly across
 * transports.
 */
export class DirectTransport implements Transport {
  readonly kind = 'direct';
  private readonly scheme: AuthScheme;
  private readonly credential: DirectCredential;
  private readonly fetchImpl: FetchLike;

  constructor(options: DirectTransportOptions) {
    this.scheme = options.scheme;
    this.credential = options.credential;
    this.fetchImpl = resolveFetch(options.fetchImpl);
  }

  async send(request: NormalizedRequest): Promise<NormalizedResponse> {
    const prepared = this.applyAuth(request);
    const wireBody = this.encodeBody(prepared);
    const res = await this.fetchImpl(prepared.url, {
      method: prepared.method,
      headers: prepared.headers,
      ...(wireBody !== undefined ? { body: wireBody } : {}),
      ...(prepared.signal ? { signal: prepared.signal } : {}),
    });

    const headers: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    // A binary read hands back the raw bytes verbatim — never text-decoded (that
    // would corrupt them) — so an action can pass a downloaded file downstream.
    if (prepared.responseType === 'binary') {
      const bytes = Buffer.from(await res.arrayBuffer());
      return { status: res.status, headers, data: bytes };
    }
    const text = await res.text();
    return { status: res.status, headers, data: parseBody(text, headers['content-type']) };
  }

  /**
   * Serialise the request body for the wire and set its Content-Type. A
   * multipart body is encoded to raw bytes with a boundary header; a form body is
   * encoded to a `key=value&…` string with the url-encoded content-type; a JSON
   * body is stringified (both special bodies mutate the already-copied
   * `prepared.headers`); absent → no body.
   */
  private encodeBody(prepared: NormalizedRequest): string | Buffer | undefined {
    if (prepared.body === undefined) return undefined;
    if (isMultipartBody(prepared.body)) {
      const { body, contentType } = encodeMultipart(prepared.body);
      prepared.headers['content-type'] = contentType;
      return body;
    }
    if (isFormBody(prepared.body)) {
      prepared.headers['content-type'] = 'application/x-www-form-urlencoded';
      return encodeForm(prepared.body);
    }
    return JSON.stringify(prepared.body);
  }

  /** Attach the credential to a COPY of the request (never mutate the caller's object). */
  private applyAuth(request: NormalizedRequest): NormalizedRequest {
    // A single mutable copy the branches (and custom.apply) write into.
    const prepared: NormalizedRequest = { ...request, headers: { ...request.headers } };
    const cred = this.credential;

    switch (this.scheme.type) {
      case 'none':
        break;
      case 'oauth2':
        if (cred.type === 'bearer') prepared.headers['authorization'] = `Bearer ${cred.token}`;
        break;
      case 'apiKey': {
        if (cred.type === 'apiKey') {
          const value = (this.scheme.prefix ?? '') + cred.value;
          if (this.scheme.in === 'header') prepared.headers[this.scheme.name.toLowerCase()] = value;
          else prepared.url = appendQuery(prepared.url, { [this.scheme.name]: value });
        } else if (cred.type === 'bearer' && this.scheme.in === 'header') {
          // Common case: a bearer token declared as an Authorization apiKey.
          prepared.headers[this.scheme.name.toLowerCase()] = (this.scheme.prefix ?? '') + cred.token;
        }
        break;
      }
      case 'basic':
        if (cred.type === 'basic') {
          const encoded = Buffer.from(`${cred.username}:${cred.password}`).toString('base64');
          prepared.headers['authorization'] = `Basic ${encoded}`;
        }
        break;
      case 'custom':
        this.scheme.apply(prepared, cred);
        break;
      default: {
        // Exhaustiveness guard — a new scheme type must be handled explicitly.
        const _exhaustive: never = this.scheme;
        throw new ActionError({
          code: 'auth_unsupported',
          message: `unsupported auth scheme: ${JSON.stringify(_exhaustive)}`,
          retryable: false,
        });
      }
    }
    return prepared;
  }
}

/** Parse a response body: JSON when the content-type says so, else the raw text. */
function parseBody(text: string, contentType: string | undefined): unknown {
  if (text.length === 0) return undefined;
  if (contentType && contentType.toLowerCase().includes('application/json')) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      // A JSON content-type with a non-JSON body is a provider bug; surface the raw text.
      return text;
    }
  }
  return text;
}
