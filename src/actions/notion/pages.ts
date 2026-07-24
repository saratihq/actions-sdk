import { defineAction } from '../../core/action';
import type { JsonValue } from '../../core/http/types';
import { dropdown, json, shortText } from '../../core/props';
import { databaseOptions, NOTION_API_BASE, NOTION_HEADERS, type NotionObject, notionAuth } from './common';

/** Public types — stable public catalog ids. */
export const CREATE_PAGE_TYPE = 'notion.create_page';
export const GET_PAGE_TYPE = 'notion.get_page';
export const UPDATE_PAGE_TYPE = 'notion.update_page';

/**
 * Create a page as a row in a database. The **database picker is live**;
 * `properties` is raw Notion JSON keyed by the database's own columns (whose
 * shape a picker can't yet resolve).
 */
export const createPage = defineAction({
  type: CREATE_PAGE_TYPE,
  name: 'Create page',
  description: 'Create a page (database row) in Notion.',
  auth: notionAuth,
  props: {
    databaseId: dropdown<string, true>({
      label: 'Database',
      description: 'Loaded live; type to search.',
      required: true,
      options: ({ auth, http, search: term }) => databaseOptions(http, auth, term),
    }),
    properties: json<true>({
      label: 'Properties',
      description: 'Notion page properties keyed by the database columns.',
      required: true,
    }),
    children: json({
      label: 'Content blocks',
      description: 'Optional array of Notion block objects.',
      required: false,
    }),
  },
  async run({ auth, props, http }): Promise<NotionObject> {
    const body: Record<string, JsonValue> = {
      parent: { database_id: props.databaseId },
      properties: props.properties,
    };
    if (props.children !== undefined) body.children = props.children;
    const res = await http.post<NotionObject>(`${NOTION_API_BASE}/pages`, {
      auth,
      headers: NOTION_HEADERS,
      body,
    });
    return res.data;
  },
});

/** Retrieve a page's properties by id. Read-only. */
export const getPage = defineAction({
  type: GET_PAGE_TYPE,
  name: 'Get page',
  description: 'Retrieve a Notion page by id.',
  auth: notionAuth,
  props: {
    pageId: shortText<true>({ label: 'Page id', required: true }),
  },
  async run({ auth, props, http }): Promise<NotionObject> {
    const res = await http.get<NotionObject>(`${NOTION_API_BASE}/pages/${encodeURIComponent(props.pageId)}`, {
      auth,
      headers: NOTION_HEADERS,
    });
    return res.data;
  },
});

/** Update a page's properties, or archive it. */
export const updatePage = defineAction({
  type: UPDATE_PAGE_TYPE,
  name: 'Update page',
  description: 'Update a Notion page.',
  auth: notionAuth,
  props: {
    pageId: shortText<true>({ label: 'Page id', required: true }),
    properties: json({ label: 'Properties', description: 'Notion page properties to set.', required: false }),
    archived: dropdown<string, false>({
      label: 'Archived',
      required: false,
      options: [
        { label: 'Archive', value: 'true' },
        { label: 'Restore', value: 'false' },
      ],
    }),
  },
  async run({ auth, props, http }): Promise<NotionObject> {
    const body: Record<string, JsonValue> = {};
    if (props.properties !== undefined) body.properties = props.properties;
    if (props.archived !== undefined) body.archived = props.archived === 'true';
    const res = await http.patch<NotionObject>(
      `${NOTION_API_BASE}/pages/${encodeURIComponent(props.pageId)}`,
      {
        auth,
        headers: NOTION_HEADERS,
        body,
      },
    );
    return res.data;
  },
});
