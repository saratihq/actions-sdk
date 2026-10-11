import { createHash } from 'node:crypto';
import { isNativeError } from 'node:util/types';

import type { AuthScheme, DirectCredential } from '../auth';
import { ActionError, transportFailure } from '../errors';
import { type CredentialScope, credentialScope } from './credential-scope';
import { encodeForm } from './form';
import { guardedFetch } from './guarded-fetch';
import { encodeMultipart } from './multipart';
import {
  appendQuery,
  FORM,
  type FetchLike,
  isFormBody,
  isMultipartBody,
  MULTIPART,
  type NormalizedRequest,
  type NormalizedResponse,
  type RequestBody,
  type Transport,
} from './types';

export interface DirectTransportOptions {
  scheme: AuthScheme;
  credential: DirectCredential;
  /** Replaces the SSRF-guarded network hop ({@link guardedFetch}), which switches the guard off; for tests only. */
  fetchImpl?: FetchLike;
}

/** Sends straight to the provider with the BYO credential attached per the declared {@link AuthScheme}. */
export class DirectTransport implements Transport {
  readonly kind = 'direct';
  private readonly scheme: AuthScheme;
  private readonly credential: DirectCredential;
  private readonly fetchImpl: FetchLike;
  private readonly scope: CredentialScope | null;

  constructor(options: DirectTransportOptions) {
    this.scheme = options.scheme;
    this.credential = options.credential;
    this.fetchImpl = options.fetchImpl ?? guardedFetch;
    this.scope = credentialScope(options.scheme);
  }

  async send(request: NormalizedRequest): Promise<NormalizedResponse> {
    const custom = this.scheme.type === 'custom';
    const bodyBefore = custom ? bodyFingerprint(request.body) : undefined;
    const prepared = await this.applyAuth(request, bodyBefore);
    if (this.scope) prepared.url = this.scope.admit(prepared.url).href;
    const credentialHeaders = changedHeaders(request.headers, prepared.headers);
    const credentialParams = changedParams(request.url, prepared.url);
    const bodyAfter = custom ? bodyFingerprint(prepared.body) : undefined;
    const credentialBody = custom && bodyAfter !== bodyBefore;
    const wireBody = this.encodeBody(prepared, bodyAfter);
    const res = await this.fetchImpl(prepared.url, {
      method: prepared.method,
      headers: prepared.headers,
      ...(wireBody !== undefined ? { body: wireBody } : {}),
      ...(prepared.signal ? { signal: prepared.signal } : {}),
      ...(credentialHeaders.length > 0 ? { credentialHeaders } : {}),
      ...(credentialParams.length > 0 ? { credentialParams } : {}),
      ...(credentialBody ? { credentialBody } : {}),
    });

    const headers: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    // Binary hands back raw bytes verbatim — text-decoding them would corrupt the file.
    if (prepared.responseType === 'binary') {
      const bytes = await readBody(res.url || prepared.url, () =>
        res.arrayBuffer().then((buffer) => Buffer.from(buffer)),
      );
      return { status: res.status, headers, data: bytes };
    }
    const text = await readBody(res.url || prepared.url, () => res.text());
    return { status: res.status, headers, data: parseBody(text, headers['content-type']) };
  }

  /** Serialise the body for the wire and set its Content-Type on the already-copied `prepared.headers`; a JSON body's fingerprint is its wire text. */
  private encodeBody(prepared: NormalizedRequest, fingerprint?: string): string | Buffer | undefined {
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
    return fingerprint ?? JSON.stringify(prepared.body);
  }

  /** Attach the credential to a COPY of the request (never mutate the caller's object). */
  private async applyAuth(
    request: NormalizedRequest,
    bodyFingerprintBefore?: string,
  ): Promise<NormalizedRequest> {
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
      case 'custom': {
        const copy = prepared.body === undefined ? undefined : copyBody(prepared.body, bodyFingerprintBefore);
        if (copy === undefined) delete prepared.body;
        else prepared.body = copy;
        try {
          await this.scheme.apply(prepared, cred);
        } catch (err) {
          if (err instanceof ActionError) throw err;
          throw new ActionError({
            code: 'invalid_input',
            message: `a custom scheme's apply failed, so nothing was sent: ${err instanceof Error ? err.message : String(err)}`,
            retryable: false,
            cause: err,
          });
        }
        break;
      }
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

async function readBody<T>(url: string, read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (err) {
    if (err instanceof ActionError) throw err;
    const cause = (err as { cause?: unknown } | null)?.cause;
    const reason = isNativeError(cause) ? cause : isNativeError(err) ? err : new Error(String(err));
    throw transportFailure(new URL(url).origin, reason, 'response');
  }
}

// apply() edits a copy taken through the wire form, so a retry or a reused body starts clean.
function copyBody(body: RequestBody, fingerprint: string | undefined): RequestBody | undefined {
  if (isMultipartBody(body)) {
    return {
      [MULTIPART]: true,
      parts: body.parts.map((part) =>
        part.type === 'file' ? { ...part, data: Buffer.from(part.data) } : { ...part },
      ),
    };
  }
  if (isFormBody(body))
    return { [FORM]: true, fields: body.fields.map(([name, value]) => [name, value] as const) };
  return fingerprint === undefined ? undefined : (JSON.parse(fingerprint) as RequestBody);
}

/** What a body would send: a JSON body's exact wire text, form fields, or multipart parts with each file's sha256. */
function bodyFingerprint(body: RequestBody | undefined): string | undefined {
  if (body === undefined) return undefined;
  if (isMultipartBody(body)) {
    return JSON.stringify(
      body.parts.map((part) =>
        part.type === 'file' ? { ...part, data: createHash('sha256').update(part.data).digest('hex') } : part,
      ),
    );
  }
  return JSON.stringify(isFormBody(body) ? body.fields : body);
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
