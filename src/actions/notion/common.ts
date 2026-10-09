import type { ApiKeyScheme, AuthHandle } from '../../core/auth';
import type { HttpClient } from '../../core/http/client';
import type { JsonValue } from '../../core/http/types';
import type { DropdownOption } from '../../core/props';

/** Shared Notion `/v1` building blocks: Bearer auth, the required version header, rich-text titles. */

export const NOTION_API_BASE = 'https://api.notion.com/v1';

/** Notion pins a dated API version; the response shapes depend on it. */
export const NOTION_HEADERS: Record<string, string> = { 'notion-version': '2022-06-28' };

/** Notion authenticates with an integration/OAuth token as a Bearer credential. */
export const notionAuth: ApiKeyScheme = {
  type: 'apiKey',
  origins: ['https://api.notion.com'],
  in: 'header',
  name: 'Authorization',
  prefix: 'Bearer ',
};

/** A Notion rich-text run (only the fields used to derive a plain title). */
interface RichText {
  plain_text?: string;
}

/** A Notion object (database or page), trimmed to what pickers and reads use. */
export interface NotionObject {
  id: string;
  object: string;
  title?: RichText[];
  url?: string;
  properties?: Record<string, JsonValue>;
  archived?: boolean;
}

/** Search envelope. */
export interface NotionSearchResult {
  results: NotionObject[];
  has_more: boolean;
  next_cursor?: string | null;
}

/** Derive a human title from a Notion object's rich-text `title` array. */
export function plainTitle(object: NotionObject): string {
  const text = (object.title ?? [])
    .map((run) => run.plain_text ?? '')
    .join('')
    .trim();
  return text.length > 0 ? text : 'Untitled';
}

/** Live database picker (prop-independent, per the loader contract); honours the loader `search` term. */
export async function databaseOptions(
  http: HttpClient,
  auth: AuthHandle,
  search?: string,
): Promise<DropdownOption<string>[]> {
  const res = await http.post<NotionSearchResult>(`${NOTION_API_BASE}/search`, {
    auth,
    headers: NOTION_HEADERS,
    body: {
      ...(search ? { query: search } : {}),
      filter: { property: 'object', value: 'database' },
      page_size: 100,
    },
  });
  return res.data.results.map((database) => ({ label: plainTitle(database), value: database.id }));
}

/** Walk Notion's in-body `start_cursor` pagination up to `maxResults`; `maxPages` caps a runaway cursor. */
export async function collectNotionQuery(
  http: HttpClient,
  auth: AuthHandle,
  url: string,
  body: Record<string, JsonValue>,
  maxResults: number,
  maxPages = 25,
): Promise<NotionObject[]> {
  const objects: NotionObject[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page += 1) {
    const remaining = maxResults - objects.length;
    const pageBody: Record<string, JsonValue> = { ...body, page_size: Math.min(100, Math.max(1, remaining)) };
    if (cursor) pageBody.start_cursor = cursor;
    const res = await http.post<NotionSearchResult>(url, { auth, headers: NOTION_HEADERS, body: pageBody });
    objects.push(...res.data.results);
    if (objects.length >= maxResults) return objects.slice(0, maxResults);
    if (!res.data.has_more || !res.data.next_cursor) return objects;
    cursor = res.data.next_cursor;
  }
  return objects;
}
