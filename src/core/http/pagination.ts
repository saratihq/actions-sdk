import type { AuthHandle } from '../auth';
import { ActionError } from '../errors';
import { HttpClient, type HttpResponse } from './client';
import { appendQuery, type QueryValue } from './types';

/** Given the page just fetched and its URL, return the next page's absolute URL, or null to stop. */
export type NextPageFn = (response: HttpResponse, currentUrl: string) => string | null;

export interface PaginateOptions<TItem> {
  http: HttpClient;
  auth: AuthHandle;
  /** The first page's URL (query params included, or supply them separately). */
  url: string;
  query?: Record<string, QueryValue>;
  headers?: Record<string, string>;
  /** Pull the item array out of one page. Caller narrows the page shape. */
  extractItems: (response: HttpResponse) => TItem[];
  /** How to advance; use {@link cursorInBody} or {@link linkHeader}. */
  nextPage: NextPageFn;
  /** Stop once this many items are collected (result is sliced to it). */
  maxItems?: number;
  /** Hard safety cap on page fetches; a runaway cursor throws rather than looping forever. */
  maxPages?: number;
}

const DEFAULT_MAX_PAGES = 50;

/** Follow a provider's pagination to completion, collecting items across pages — the SDK's one pagination path. */
export async function paginate<TItem>(options: PaginateOptions<TItem>): Promise<TItem[]> {
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  let url = appendQuery(options.url, options.query);
  const collected: TItem[] = [];

  for (let page = 0; ; page += 1) {
    if (page >= maxPages) {
      throw new ActionError({
        code: 'pagination_limit',
        message: `pagination exceeded ${maxPages} pages — aborting to avoid an unbounded loop`,
        retryable: false,
      });
    }
    const response = await options.http.get(url, {
      auth: options.auth,
      ...(options.headers ? { headers: options.headers } : {}),
    });
    collected.push(...options.extractItems(response));

    if (options.maxItems !== undefined && collected.length >= options.maxItems) {
      return collected.slice(0, options.maxItems);
    }
    const next = options.nextPage(response, url);
    if (!next) return collected;
    url = next;
  }
}

/** Cursor-in-body pagination: the cursor is written back onto the same URL's query, preserving other params. */
export function cursorInBody(config: { cursorPath: string[]; cursorParam: string }): NextPageFn {
  return (response, currentUrl) => {
    const cursor = readPath(response.data, config.cursorPath);
    if (typeof cursor !== 'string' || cursor.length === 0) return null;
    return setQueryParam(currentUrl, config.cursorParam, cursor);
  };
}

/** RFC 5988 Link-header pagination; returns the `rel="next"` URL verbatim. */
export function linkHeader(rel = 'next'): NextPageFn {
  return (response) => {
    const link = response.headers['link'];
    if (!link) return null;
    return parseLinkHeader(link)[rel] ?? null;
  };
}

// ─── internals ───

/** Read a nested value by key path; returns undefined if any hop is missing. */
function readPath(data: unknown, path: string[]): unknown {
  let current: unknown = data;
  for (const key of path) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** Set or replace one query param on a URL, preserving the rest. */
function setQueryParam(url: string, key: string, value: string): string {
  const questionIndex = url.indexOf('?');
  const base = questionIndex === -1 ? url : url.slice(0, questionIndex);
  const params = new URLSearchParams(questionIndex === -1 ? '' : url.slice(questionIndex + 1));
  params.set(key, value);
  const search = params.toString();
  return search ? `${base}?${search}` : base;
}

/** Parse an RFC 5988 `Link` header into a `{ rel: url }` map. */
function parseLinkHeader(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of header.split(',')) {
    const match = /<([^>]+)>\s*;\s*rel="([^"]+)"/.exec(part.trim());
    if (match?.[1] && match[2]) out[match[2]] = match[1];
  }
  return out;
}
