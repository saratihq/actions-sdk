import { defineAction } from '../../core/action';
import type { JsonValue } from '../../core/http/types';
import { checkbox, number, shortText } from '../../core/props';
import {
  DROPBOX_API_BASE,
  type DropboxEntry,
  type DropboxSearchResult,
  type DropboxTemporaryLink,
  dropboxAuth,
  listFolderPaged,
} from './common';

/**
 * Public types — aligned to the catalog ids where one exists so the host runtime's
 * dedup replaces the prior row with this one and any plan referencing the
 * established id routes to this action. The prior `list_dropbox_folder`,
 * `create_new_dropbox_folder`, `search_dropbox`, and `get_dropbox_file_link`
 * ids are already underscore ids → reused verbatim. `get_metadata` has no prior
 * equivalent → a new underscore id.
 */
export const LIST_FOLDER_TYPE = 'dropbox.list_dropbox_folder';
export const GET_METADATA_TYPE = 'dropbox.get_file_metadata';
export const CREATE_FOLDER_TYPE = 'dropbox.create_new_dropbox_folder';
export const SEARCH_TYPE = 'dropbox.search_dropbox';
export const GET_TEMPORARY_LINK_TYPE = 'dropbox.get_dropbox_file_link';

/**
 * List the contents of a folder. Dropbox addresses the root as an empty path
 * (`""`); a sub-folder is a leading-slash path like `/Documents`. Follows
 * Dropbox's cursor pagination up to `limit`.
 */
export const listFolder = defineAction({
  type: LIST_FOLDER_TYPE,
  name: 'List a folder',
  description: 'List the files and folders in a Dropbox folder.',
  auth: dropboxAuth,
  props: {
    path: shortText({
      label: 'Path',
      description: 'Folder path, e.g. /Documents. Leave blank for the root.',
      required: false,
    }),
    recursive: checkbox({
      label: 'Recursive',
      description: 'Include the contents of sub-folders.',
      required: false,
      defaultValue: false,
    }),
    limit: number({ label: 'Max results', required: false, defaultValue: 100 }),
  },
  async run({ auth, props, http }): Promise<{ entries: DropboxEntry[]; count: number }> {
    const entries = await listFolderPaged(
      http,
      auth,
      { path: props.path ?? '', recursive: props.recursive ?? false },
      props.limit ?? 100,
    );
    return { entries, count: entries.length };
  },
});

/** Get a file or folder's metadata by path. Read-only. */
export const getFileMetadata = defineAction({
  type: GET_METADATA_TYPE,
  name: 'Get file metadata',
  description: 'Get a Dropbox file or folder’s metadata by path.',
  auth: dropboxAuth,
  props: {
    path: shortText<true>({
      label: 'Path',
      description: 'The file or folder path, e.g. /Documents/report.pdf.',
      required: true,
    }),
  },
  async run({ auth, props, http }): Promise<DropboxEntry> {
    const res = await http.post<DropboxEntry>(`${DROPBOX_API_BASE}/files/get_metadata`, {
      auth,
      body: { path: props.path },
    });
    return res.data;
  },
});

/** Create a folder. `autorename` avoids a conflict by renaming instead of failing. */
export const createFolder = defineAction({
  type: CREATE_FOLDER_TYPE,
  name: 'Create new folder',
  description: 'Create a folder in Dropbox.',
  auth: dropboxAuth,
  props: {
    path: shortText<true>({
      label: 'Path',
      description: 'The new folder path, e.g. /Reports/2026.',
      required: true,
    }),
    autorename: checkbox({
      label: 'Auto-rename on conflict',
      description: 'Rename automatically if a folder already exists at the path.',
      required: false,
      defaultValue: false,
    }),
  },
  async run({ auth, props, http }): Promise<DropboxEntry> {
    const res = await http.post<{ metadata: DropboxEntry }>(`${DROPBOX_API_BASE}/files/create_folder_v2`, {
      auth,
      body: { path: props.path, autorename: props.autorename ?? false },
    });
    return res.data.metadata;
  },
});

/**
 * Search files and folders by name/content. Scoped to `path` (the whole account
 * when blank) and capped at `max` matches (Dropbox allows up to 1000 per page).
 */
export const search = defineAction({
  type: SEARCH_TYPE,
  name: 'Search',
  description: 'Search for files and folders in Dropbox.',
  auth: dropboxAuth,
  props: {
    query: shortText<true>({ label: 'Query', description: 'What to search for.', required: true }),
    path: shortText({
      label: 'Within path',
      description: 'Restrict the search to this folder; blank searches everything.',
      required: false,
    }),
    max: number({ label: 'Max results', required: false, defaultValue: 100 }),
  },
  async run({ auth, props, http }): Promise<{ entries: DropboxEntry[]; hasMore: boolean; count: number }> {
    const options: Record<string, JsonValue> = { max_results: props.max ?? 100 };
    if (props.path && props.path.trim() !== '') options.path = props.path;
    const res = await http.post<DropboxSearchResult>(`${DROPBOX_API_BASE}/files/search_v2`, {
      auth,
      body: { query: props.query, options },
    });
    const entries = (res.data.matches ?? [])
      .map((match) => match.metadata?.metadata)
      .filter((entry): entry is DropboxEntry => entry !== undefined);
    return { entries, hasMore: res.data.has_more ?? false, count: entries.length };
  },
});

/**
 * Get a short-lived (≈4h) direct download URL for a file. This is the
 * managed-safe way to hand a caller a file's contents without moving bytes over
 * the JSON-only proxy (see common.ts) — the link can be fetched directly.
 */
export const getTemporaryLink = defineAction({
  type: GET_TEMPORARY_LINK_TYPE,
  name: 'Get temporary file link',
  description: 'Get a temporary direct download link for a Dropbox file.',
  auth: dropboxAuth,
  props: {
    path: shortText<true>({
      label: 'Path',
      description: 'The file path, e.g. /Documents/report.pdf.',
      required: true,
    }),
  },
  async run({ auth, props, http }): Promise<DropboxTemporaryLink> {
    const res = await http.post<DropboxTemporaryLink>(`${DROPBOX_API_BASE}/files/get_temporary_link`, {
      auth,
      body: { path: props.path },
    });
    return res.data;
  },
});
