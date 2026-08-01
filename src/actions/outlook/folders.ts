import { defineAction } from '../../core/action';
import { paginate } from '../../core/http/pagination';
import { number } from '../../core/props';
import { GRAPH_ME_BASE, odataNextLink, type OutlookMailFolder, outlookAuth } from './common';

/** Public action type id — no reusable equivalent exists, so a new underscore id. */
export const LIST_FOLDERS_TYPE = 'outlook.list_folders';

/** List mail folders, walking `@odata.nextLink` up to `limit`; the ids feed `folderId` on `list_messages`. */
export const listFolders = defineAction({
  type: LIST_FOLDERS_TYPE,
  name: 'List folders',
  description: 'List the mail folders in the connected Outlook mailbox.',
  auth: outlookAuth,
  props: {
    limit: number({ label: 'Max results', required: false, defaultValue: 100 }),
  },
  async run({ auth, props, http }): Promise<{ folders: OutlookMailFolder[]; count: number }> {
    const folders = await paginate<OutlookMailFolder>({
      http,
      auth,
      url: `${GRAPH_ME_BASE}/mailFolders`,
      query: { $top: 100 },
      extractItems: (res) => (res.data as { value?: OutlookMailFolder[] }).value ?? [],
      nextPage: odataNextLink,
      maxItems: props.limit ?? 100,
    });
    return { folders, count: folders.length };
  },
});
