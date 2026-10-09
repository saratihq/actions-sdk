import zlib from 'node:zlib';

import { fetch as plainFetch } from 'undici';

import type { AuthScheme, DirectCredential, NoneScheme } from '../auth';
import { createDirectAuth } from '../auth-factories';
import {
  type LoopbackHit,
  type LoopbackServer,
  startLoopbackServer,
  withAllowedHosts,
} from '../../testing/loopback-server';
import { HttpClient, type HttpResponse, type RequestOptions } from './client';
import type { FetchLike, HttpMethod } from './types';

/**
 * Ordinary requests must reach the server, and come back to the caller, exactly as plain fetch delivers them:
 * the guard may refuse private targets, never an ordinary request to an allowed one.
 */
type Unscoped<T> = T extends unknown ? Omit<T, 'origins'> : never;

describe('guarded hop — parity with plain fetch for ordinary requests', () => {
  let server: LoopbackServer;
  let base: string;
  const fetchOnly: FetchLike = (input, init) => plainFetch(input, init);
  const http = new HttpClient({ retry: { retries: 0 } });

  beforeAll(async () => {
    server = await startLoopbackServer((req, res, hit) => {
      const path = hit.url.split('?')[0] ?? '';
      const redirect = /^\/redirect-(\d{3})$/.exec(path);
      if (redirect) {
        res.writeHead(Number(redirect[1]), { location: '/json' });
        res.end();
      } else if (path === '/gzip') {
        res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
        res.end(zlib.gzipSync(JSON.stringify({ zipped: true })));
      } else if (path === '/br') {
        res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'br' });
        res.end(zlib.brotliCompressSync(JSON.stringify({ brotli: true })));
      } else if (path === '/binary') {
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.end(Buffer.from([0, 1, 2, 250, 255]));
      } else if (path === '/empty') {
        res.writeHead(204);
        res.end();
      } else if (path === '/text') {
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('plain text café');
      } else {
        res.writeHead(200, { 'content-type': 'application/json', 'x-echo-method': req.method ?? '' });
        res.end(JSON.stringify({ ok: true, method: req.method }));
      }
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterAll(() => server.close());

  interface Case {
    method: HttpMethod;
    path: string;
    options?: Omit<RequestOptions, 'auth'>;
    scheme?: Unscoped<Exclude<AuthScheme, NoneScheme>>;
    credential?: DirectCredential;
  }

  // A multipart boundary is random per request, so it is the one byte-level difference allowed.
  const withoutBoundary = ({ headers, body, ...rest }: LoopbackHit) => {
    const boundary = /boundary=(\S+)/.exec(String(headers['content-type']))?.[1];
    const plain = (text: string): string => (boundary ? text.split(boundary).join('BOUNDARY') : text);
    const kept = Object.fromEntries(
      Object.entries(headers)
        .filter(([name]) => name !== 'connection')
        .map(([name, value]) => [name, typeof value === 'string' ? plain(value) : value]),
    );
    return { ...rest, body: plain(body), headers: kept };
  };

  const send = async (c: Case, fetchImpl?: FetchLike) => {
    const before = server.hits.length;
    const scheme: AuthScheme = c.scheme ? { ...c.scheme, origins: [base] } : { type: 'none' };
    const credential = c.credential ?? { type: 'none' };
    const auth = fetchImpl
      ? createDirectAuth(scheme, credential, { fetchImpl })
      : createDirectAuth(scheme, credential);
    const result: HttpResponse | { failed: string } = await http
      .request(c.method, `${base}${c.path}`, { auth, ...c.options })
      .catch((err: Error) => ({ failed: err.message }));
    const hits = server.hits.slice(before).map(withoutBoundary);
    return { result, hits };
  };

  it.each<[string, Case]>([
    [
      'a GET with unicode and repeated query params',
      { method: 'GET', path: '/json', options: { query: { q: 'café ☕', list: [1, 2] } } },
    ],
    [
      'a JSON POST',
      { method: 'POST', path: '/json', options: { body: { a: 1, nested: { b: [true, null, 'x'] } } } },
    ],
    [
      'unusual but valid headers',
      {
        method: 'PUT',
        path: '/json',
        options: {
          body: { put: true },
          headers: {
            'X-Custom_Header.v2': 'value with "quotes",\ttab and ; semicolons',
            'x-latin1': 'café naïve',
            'x-empty': '',
            'x-padded': '  padded  ',
            'x-trailing-newline': 'from a step\n',
            accept: 'application/vnd.api+json',
          },
        },
      },
    ],
    [
      'a bearer credential saved with a trailing newline',
      {
        method: 'GET',
        path: '/json',
        scheme: { type: 'oauth2' },
        credential: { type: 'bearer', token: 'tok_abc\r\n' },
      },
    ],
    [
      'an apiKey in the query string',
      {
        method: 'GET',
        path: '/json',
        scheme: { type: 'apiKey', in: 'query', name: 'api_key' },
        credential: { type: 'apiKey', value: 'k-123' },
      },
    ],
    [
      'basic auth',
      {
        method: 'GET',
        path: '/json',
        scheme: { type: 'basic' },
        credential: { type: 'basic', username: 'ann', password: 'p@ss:w' },
      },
    ],
    [
      'a multipart upload',
      {
        method: 'POST',
        path: '/json',
        options: {
          multipart: {
            fields: { title: 'report' },
            files: {
              file: { filename: 'r.bin', data: Buffer.from([1, 2, 3]), mimeType: 'application/octet-stream' },
            },
          },
        },
      },
    ],
    [
      'a url-encoded form',
      { method: 'POST', path: '/json', options: { form: { a: 'b c', list: ['x', 'y'] } } },
    ],
    ['a gzip response', { method: 'GET', path: '/gzip' }],
    ['a brotli response', { method: 'GET', path: '/br' }],
    ['a binary response', { method: 'GET', path: '/binary', options: { responseType: 'binary' } }],
    ['a text response', { method: 'GET', path: '/text' }],
    ['a 204', { method: 'GET', path: '/empty' }],
    ['a HEAD', { method: 'HEAD', path: '/json' }],
    ['a DELETE', { method: 'DELETE', path: '/json' }],
    ['a POST that 301s', { method: 'POST', path: '/redirect-301', options: { body: { a: 1 } } }],
    ['a POST that 302s', { method: 'POST', path: '/redirect-302', options: { body: { a: 1 } } }],
    ['a POST that 303s', { method: 'POST', path: '/redirect-303', options: { body: { a: 1 } } }],
    ['a POST that 307s', { method: 'POST', path: '/redirect-307', options: { body: { a: 1 } } }],
    ['a PUT that 308s', { method: 'PUT', path: '/redirect-308', options: { body: { a: 1 } } }],
  ])('%s reaches the server and the caller as plain fetch delivers it', async (_label, c) => {
    const plain = await send(c, fetchOnly);
    const guarded = await withAllowedHosts('127.0.0.1', () => send(c));
    expect('failed' in plain.result).toBe(false);
    expect(guarded).toEqual(plain);
  });
});
