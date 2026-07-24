import { defineAction } from '../../core/action';
import type { JsonValue } from '../../core/http/types';
import { json, shortText } from '../../core/props';
import { NOTION_API_BASE, NOTION_HEADERS, notionAuth } from './common';

/**
 * Reuses the existing catalog id `notion.append_to_page` so the host runtime's
 * dedup replaces that prior row with this one. Notion appends block children to ANY
 * block via `PATCH /v1/blocks/{block_id}/children`; a page IS a block, so the one
 * verb covers "append to a page" and "append to a block".
 */
export const APPEND_BLOCK_CHILDREN_TYPE = 'notion.append_to_page';

/** The response from appending block children — the newly-created child blocks. */
export interface AppendBlockChildrenResult {
  object: string;
  results: JsonValue[];
}

/** Append block children to a Notion page or block. */
export const appendBlockChildren = defineAction({
  type: APPEND_BLOCK_CHILDREN_TYPE,
  name: 'Append block children',
  description: 'Append block children to a Notion page or block.',
  auth: notionAuth,
  props: {
    blockId: shortText<true>({
      label: 'Page or block id',
      description: 'The parent to append to — a page id or a block id.',
      required: true,
    }),
    children: json<true>({
      label: 'Children',
      description: 'An array of Notion block objects to append.',
      required: true,
    }),
    after: shortText({
      label: 'After block id',
      description: 'Append the new children after this existing child block (optional).',
      required: false,
    }),
  },
  async run({ auth, props, http }): Promise<AppendBlockChildrenResult> {
    const body: Record<string, JsonValue> = { children: props.children };
    if (props.after !== undefined) body.after = props.after;
    const res = await http.patch<AppendBlockChildrenResult>(
      `${NOTION_API_BASE}/blocks/${encodeURIComponent(props.blockId)}/children`,
      { auth, headers: NOTION_HEADERS, body },
    );
    return res.data;
  },
});
