import { defineTrigger } from '../../core/trigger';
import type { JsonValue } from '../../core/http/types';
import { shortText } from '../../core/props';

/**
 * Generic HTTP polling trigger: GET a URL, extract an item array, let the SDK dedupe.
 * `dedupeKey(item)` receives only the item, so identity comes from an id-like field or its canonical JSON.
 */

/** Navigate a dot-path (e.g. `data.items`) into a JSON value; undefined if absent. */
function atPath(value: JsonValue | undefined, path: string): JsonValue | undefined {
  if (!path) return value;
  let cursor: JsonValue | undefined = value;
  for (const segment of path.split('.')) {
    if (cursor && typeof cursor === 'object' && !Array.isArray(cursor)) {
      cursor = cursor[segment];
    } else {
      return undefined;
    }
  }
  return cursor;
}

/** A stable dedupe key for an arbitrary JSON item. */
export function httpItemKey(item: JsonValue): string {
  if (item && typeof item === 'object' && !Array.isArray(item)) {
    for (const key of ['id', 'guid', 'uuid', 'key']) {
      const value = item[key];
      if (typeof value === 'string' || typeof value === 'number') return `${key}:${value}`;
    }
  }
  return JSON.stringify(item);
}

export const HTTP_NEW_ITEM_TYPE = 'http.new_item';

export const newItem = defineTrigger({
  type: HTTP_NEW_ITEM_TYPE,
  strategy: 'polling',
  name: 'New item from HTTP endpoint',
  description: 'Fires for each new item returned by polling an HTTP endpoint.',
  auth: { type: 'none' },
  props: {
    url: shortText({ label: 'URL', required: true }),
    itemsPath: shortText({
      label: 'Items path',
      description: 'Dot-path to the array in the response (blank = the response body is the array).',
      required: false,
    }),
  },
  async poll({ auth, props, http }): Promise<JsonValue[]> {
    const res = await http.get<JsonValue>(props.url, { auth });
    const extracted = atPath(res.data, props.itemsPath ?? '');
    return Array.isArray(extracted) ? extracted : [];
  },
  dedupeKey: httpItemKey,
});
