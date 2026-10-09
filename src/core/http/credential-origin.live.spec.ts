import { createDirectAuth } from '../auth-factories';
import { liveDescribe } from '../../testing/live';
import { HttpClient } from './client';

const KEY = 'live-probe-key';
const scopedTo = (origin: string, place: 'header' | 'query') =>
  createDirectAuth(
    place === 'header'
      ? { type: 'apiKey', origins: [origin], in: 'header', name: 'X-Api-Key' }
      : { type: 'apiKey', origins: [origin], in: 'query', name: 'key' },
    { type: 'apiKey', value: KEY },
  );
const redirect = (to: string, status = 307): string =>
  `https://httpbin.org/redirect-to?status_code=${status}&url=${encodeURIComponent(to)}`;

type Echo = { headers: Record<string, string>; args?: Record<string, string> };

/** LIVE: real TLS and real public redirects (httpbin.org → postman-echo.com); gated behind ORCHESTR_LIVE. */
liveDescribe('credential origin — live, real public redirects', () => {
  const http = new HttpClient({ retry: { retries: 1 } });
  const header = scopedTo('https://httpbin.org', 'header');

  it('attaches the credential on its own origin', async () => {
    const res = await http.get<Echo>('https://httpbin.org/headers', { auth: header });
    expect(res.data.headers['X-Api-Key']).toBe(KEY);
  });

  it('drops it when the same host downgrades the redirect to http', async () => {
    const res = await http.get<Echo>(redirect('http://httpbin.org/headers'), { auth: header });
    expect(res.data.headers.Host).toBe('httpbin.org');
    expect(res.data.headers['X-Api-Key']).toBeUndefined();
  });

  it('drops it when the redirect goes to another host', async () => {
    const res = await http.get<Echo>(redirect('https://postman-echo.com/headers'), { auth: header });
    expect(res.data.headers.host).toBe('postman-echo.com');
    expect(res.data.headers['x-api-key']).toBeUndefined();
  });

  it('strips a query-param credential the server echoed into a cross-origin redirect', async () => {
    const res = await http.get<Echo>(redirect(`https://postman-echo.com/get?keep=1&key=${KEY}`), {
      auth: scopedTo('https://httpbin.org', 'query'),
    });
    expect(res.data.args).toEqual({ keep: '1' });
  });

  it('refuses to send the credential to another origin at all', async () => {
    await expect(http.get('https://postman-echo.com/headers', { auth: header })).rejects.toMatchObject({
      code: 'credential_scope',
    });
  });
});
