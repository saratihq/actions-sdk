import type { AuthScheme, DirectCredential } from '../auth';
import { ActionError } from '../errors';
import { encodeForm } from './form';
import { guardedFetch } from './guarded-fetch';
import { encodeMultipart } from './multipart';
import {
  appendQuery,
  type FetchLike,
  isFormBody,
  isMultipartBody,
  type NormalizedRequest,
  type NormalizedResponse,
  type Transport,
} from './types';

export interface DirectTransportOptions {
  scheme: AuthScheme;
  credential: DirectCredential;
  /** Replaces the SSRF-guarded network hop ({@link guardedFetch}); for tests only. */
  fetchImpl?: FetchLike;
}

/** Sends straight to the provider with the BYO credential attached per the declared {@link AuthScheme}. */
export class DirectTransport implements Transport {
  readonly kind = 'direct';
  private readonly scheme: AuthScheme;
  private readonly credential: DirectCredential;
  private readonly fetchImpl: FetchLike;

  constructor(options: DirectTransportOptions) {
    this.scheme = options.scheme;
    this.credential = options.credential;
    this.fetchImpl = options.fetchImpl ?? guardedFetch;
  }

  async send(request: NormalizedRequest): Promise<NormalizedResponse> {
    const prepared = this.applyAuth(request);
    const credentialHeaders = changedHeaders(request.headers, prepared.headers);
    const credentialParams = changedParams(request.url, prepared.url);
    const wireBody = this.encodeBody(prepared);
    const res = await this.fetchImpl(prepared.url, {
      method: prepared.method,
      headers: prepared.headers,
      ...(wireBody !== undefined ? { body: wireBody } : {}),
      ...(prepared.signal ? { signal: prepared.signal } : {}),
      ...(credentialHeaders.length > 0 ? { credentialHeaders } : {}),
      ...(credentialParams.length > 0 ? { credentialParams } : {}),
    });

    const headers: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    // Binary hands back raw bytes verbatim — text-decoding them would corrupt the file.
    if (prepared.responseType === 'binary') {
      const bytes = Buffer.from(await res.arrayBuffer());
      return { status: res.status, headers, data: bytes };
    }
    const text = await res.text();
    return { status: res.status, headers, data: parseBody(text, headers['content-type']) };
  }

  /** Serialise the body for the wire and set its Content-Type on the already-copied `prepared.headers`. */
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

function changedHeaders(before: Record<string, string>, after: Record<string, string>): string[] {
  return Object.keys(after).filter((name) => after[name] !== before[name]);
}

function changedParams(before: string, after: string): string[] {
  if (before === after) return [];
  const was = new URL(before).searchParams;
  const now = new URL(after).searchParams;
  return [...new Set(now.keys())].filter(
    (name) => was.getAll(name).join('\n') !== now.getAll(name).join('\n'),
  );
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
