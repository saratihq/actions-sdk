import { defineTrigger } from '../../core/trigger';
import type { HttpClient } from '../../core/http/client';
import type { JsonValue } from '../../core/http/types';
import type { AuthHandle } from '../../core/auth';
import { dropdown } from '../../core/props';
import { databaseOptions, NOTION_API_BASE, NOTION_HEADERS, notionAuth } from './common';

/** Polling trigger — fires for each page created in a Notion database after the trigger is enabled. */
export const NOTION_NEW_PAGE_TYPE = 'notion.new_page';

/** Re-scan overlap (2 min) so a page created mid-poll is never missed; dedupe kills the double. */
const OVERLAP_MS = 120_000;
/** Hard page-fetch cap so a runaway cursor can't loop forever. */
const MAX_PAGES = 10;

/** A normalised new-page event — trimmed to the fields a workflow reads. */
export interface NotionPageEvent {
  /** Notion page id (UUID). */
  id: string;
  url: string;
  /** ISO 8601 creation time. */
  createdTime: string;
  /** ISO 8601 last-edit time. */
  lastEditedTime: string;
  /** Raw Notion property values, keyed by the database's columns. */
  properties: Record<string, JsonValue>;
  databaseId: string;
}

/** A Notion page object as the query endpoint returns it (fields read). */
interface NotionPageResult {
  object?: string;
  id?: string;
  url?: string;
  created_time?: string;
  last_edited_time?: string;
  properties?: Record<string, JsonValue>;
}

interface QueryEnvelope {
  results?: NotionPageResult[];
  has_more?: boolean;
  next_cursor?: string | null;
}

/** Query a database for pages created after `since`, newest-first, walking `start_cursor` to completion. */
async function queryPagesSince(
  http: HttpClient,
  auth: AuthHandle,
  databaseId: string,
  since: string,
): Promise<NotionPageResult[]> {
  const url = `${NOTION_API_BASE}/databases/${encodeURIComponent(databaseId)}/query`;
  const results: NotionPageResult[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const body: Record<string, JsonValue> = {
      filter: { timestamp: 'created_time', created_time: { after: since } },
      sorts: [{ timestamp: 'created_time', direction: 'descending' }],
      page_size: 100,
    };
    if (cursor) body.start_cursor = cursor;
    const res = await http.post<QueryEnvelope>(url, { auth, headers: NOTION_HEADERS, body });
    results.push(...(res.data.results ?? []));
    if (!res.data.has_more || !res.data.next_cursor) return results;
    cursor = res.data.next_cursor;
  }
  return results;
}

export const newPage = defineTrigger({
  type: NOTION_NEW_PAGE_TYPE,
  strategy: 'polling',
  name: 'New page',
  description: 'Fires when a page (database row) is created in a Notion database.',
  auth: notionAuth,
  props: {
    databaseId: dropdown<string, true>({
      label: 'Database',
      description: 'Loaded live; type to search.',
      required: true,
      options: ({ auth, http, search: term }) => databaseOptions(http, auth, term),
    }),
  },
  sampleData: {
    id: '59833787-2cf9-4fdf-8782-e53db20768a5',
    url: 'https://www.notion.so/Ada-Lovelace-59833787',
    createdTime: '2026-07-20T19:05:00.000Z',
    lastEditedTime: '2026-07-20T19:05:00.000Z',
    properties: { Name: { title: [{ plain_text: 'Ada Lovelace' }] } },
    databaseId: '2f26ee68-df30-4251-aad4-8ddc420cba3d',
  },
  async poll({ auth, props, http, lastPolledAt }): Promise<NotionPageEvent[]> {
    // First activation: baseline the watermark, don't backfill existing pages.
    if (!lastPolledAt) return [];

    const since = new Date(Date.parse(lastPolledAt) - OVERLAP_MS).toISOString();
    const results = await queryPagesSince(http, auth, props.databaseId, since);
    return results
      .filter((page): page is NotionPageResult & { id: string } => typeof page.id === 'string')
      .map((page) => ({
        id: page.id,
        url: page.url ?? '',
        createdTime: page.created_time ?? '',
        lastEditedTime: page.last_edited_time ?? '',
        properties: page.properties ?? {},
        databaseId: props.databaseId,
      }));
  },
  dedupeKey: (event): string => event.id,
});
