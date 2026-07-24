import { FakeTransport, stubAuth } from '../../testing/fakes';
import { HttpClient } from './client';
import { cursorInBody, linkHeader, paginate } from './pagination';
import type { NormalizedResponse } from './types';

function res(data: unknown, headers: Record<string, string> = {}): NormalizedResponse {
  return { status: 200, headers, data };
}

describe('paginate — cursor in body (Slack shape)', () => {
  it('follows response_metadata.next_cursor to completion', async () => {
    const transport = new FakeTransport((_, i) =>
      i === 0
        ? res({ items: [1, 2], response_metadata: { next_cursor: 'CUR2' } })
        : res({ items: [3], response_metadata: { next_cursor: '' } }),
    );
    const http = new HttpClient();
    const items = await paginate<number>({
      http,
      auth: stubAuth(transport),
      url: 'https://api.test/list',
      query: { limit: 2 },
      extractItems: (r) => (r.data as { items: number[] }).items,
      nextPage: cursorInBody({ cursorPath: ['response_metadata', 'next_cursor'], cursorParam: 'cursor' }),
    });
    expect(items).toEqual([1, 2, 3]);
    expect(transport.requests).toHaveLength(2);
    expect(transport.requests[1]?.url).toContain('cursor=CUR2');
    // The prior query is preserved alongside the new cursor.
    expect(transport.requests[1]?.url).toContain('limit=2');
  });

  it('stops at maxItems and slices', async () => {
    const transport = new FakeTransport(() =>
      res({ items: [1, 2, 3], response_metadata: { next_cursor: 'x' } }),
    );
    const http = new HttpClient();
    const items = await paginate<number>({
      http,
      auth: stubAuth(transport),
      url: 'https://api.test/list',
      extractItems: (r) => (r.data as { items: number[] }).items,
      nextPage: cursorInBody({ cursorPath: ['response_metadata', 'next_cursor'], cursorParam: 'cursor' }),
      maxItems: 2,
    });
    expect(items).toEqual([1, 2]);
    expect(transport.requests).toHaveLength(1);
  });
});

describe('paginate — Link header (GitHub shape)', () => {
  it('follows rel="next" until the header is absent', async () => {
    const transport = new FakeTransport((_, i) =>
      i === 0
        ? res([{ id: 1 }, { id: 2 }], { link: '<https://api.test/list?page=2>; rel="next"' })
        : res([{ id: 3 }]),
    );
    const http = new HttpClient();
    const items = await paginate<{ id: number }>({
      http,
      auth: stubAuth(transport),
      url: 'https://api.test/list?page=1',
      extractItems: (r) => (Array.isArray(r.data) ? (r.data as { id: number }[]) : []),
      nextPage: linkHeader('next'),
    });
    expect(items.map((i) => i.id)).toEqual([1, 2, 3]);
    expect(transport.requests[1]?.url).toBe('https://api.test/list?page=2');
  });
});

describe('paginate — safety', () => {
  it('aborts with pagination_limit rather than looping forever', async () => {
    const transport = new FakeTransport(() =>
      res({ items: [1], response_metadata: { next_cursor: 'always' } }),
    );
    const http = new HttpClient();
    await expect(
      paginate<number>({
        http,
        auth: stubAuth(transport),
        url: 'https://api.test/list',
        extractItems: (r) => (r.data as { items: number[] }).items,
        nextPage: cursorInBody({ cursorPath: ['response_metadata', 'next_cursor'], cursorParam: 'cursor' }),
        maxPages: 3,
      }),
    ).rejects.toMatchObject({ code: 'pagination_limit' });
  });
});
