import { defineAction } from '../../core/action';
import type { JsonValue } from '../../core/http/types';
import { dropdown, json, number, shortText } from '../../core/props';
import {
  collectNotionQuery,
  databaseOptions,
  NOTION_API_BASE,
  NOTION_HEADERS,
  type NotionObject,
  type NotionSearchResult,
  notionAuth,
} from './common';

/** Public types — stable public catalog ids. */
export const SEARCH_TYPE = 'notion.search';
export const GET_DATABASE_TYPE = 'notion.get_database';
export const QUERY_DATABASE_TYPE = 'notion.query_database';

/** Search pages and databases the integration can access. */
export const search = defineAction({
  type: SEARCH_TYPE,
  name: 'Search',
  description: 'Search Notion pages and databases.',
  auth: notionAuth,
  props: {
    query: shortText({ label: 'Query', required: false }),
    filter: dropdown<string, false>({
      label: 'Only',
      required: false,
      options: [
        { label: 'Pages', value: 'page' },
        { label: 'Databases', value: 'database' },
      ],
    }),
    pageSize: number({ label: 'Max results', required: false, defaultValue: 50 }),
  },
  async run({ auth, props, http }): Promise<NotionSearchResult> {
    const body: Record<string, JsonValue> = { page_size: props.pageSize ?? 50 };
    if (props.query !== undefined) body.query = props.query;
    if (props.filter !== undefined) body.filter = { property: 'object', value: props.filter };
    const res = await http.post<NotionSearchResult>(`${NOTION_API_BASE}/search`, {
      auth,
      headers: NOTION_HEADERS,
      body,
    });
    return res.data;
  },
});

/** Retrieve a database's schema and metadata. The database picker is live. */
export const getDatabase = defineAction({
  type: GET_DATABASE_TYPE,
  name: 'Get database',
  description: 'Retrieve a Notion database by id.',
  auth: notionAuth,
  props: {
    databaseId: dropdown<string, true>({
      label: 'Database',
      description: 'Loaded live; type to search.',
      required: true,
      options: ({ auth, http, search: term }) => databaseOptions(http, auth, term),
    }),
  },
  async run({ auth, props, http }): Promise<NotionObject> {
    const res = await http.get<NotionObject>(
      `${NOTION_API_BASE}/databases/${encodeURIComponent(props.databaseId)}`,
      { auth, headers: NOTION_HEADERS },
    );
    return res.data;
  },
});

/**
 * Query the rows (pages) of a database with optional filter/sorts, following
 * Notion's `start_cursor` pagination up to `limit`. The database picker is live;
 * the filter is raw Notion JSON (its shape depends on the DB's own columns, which
 * a picker can't yet resolve).
 */
export const queryDatabase = defineAction({
  type: QUERY_DATABASE_TYPE,
  name: 'Query database',
  description: 'Query the pages in a Notion database.',
  auth: notionAuth,
  props: {
    databaseId: dropdown<string, true>({
      label: 'Database',
      required: true,
      options: ({ auth, http, search: term }) => databaseOptions(http, auth, term),
    }),
    filter: json({ label: 'Filter', description: 'Raw Notion filter object.', required: false }),
    sorts: json({ label: 'Sorts', description: 'Raw Notion sorts array.', required: false }),
    limit: number({ label: 'Max results', required: false, defaultValue: 100 }),
  },
  async run({ auth, props, http }): Promise<{ pages: NotionObject[]; count: number }> {
    const body: Record<string, JsonValue> = {};
    if (props.filter !== undefined) body.filter = props.filter;
    if (props.sorts !== undefined) body.sorts = props.sorts;
    const pages = await collectNotionQuery(
      http,
      auth,
      `${NOTION_API_BASE}/databases/${encodeURIComponent(props.databaseId)}/query`,
      body,
      props.limit ?? 100,
    );
    return { pages, count: pages.length };
  },
});
