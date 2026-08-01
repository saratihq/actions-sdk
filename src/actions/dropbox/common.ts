import type { AuthHandle, OAuth2Scheme } from '../../core/auth';
import { ActionError } from '../../core/errors';
import type { HttpClient } from '../../core/http/client';
import type { JsonValue } from '../../core/http/types';

/**
 * Shared Dropbox (API v2) building blocks: the `/2/files/*` RPC endpoints and `.tag`-discriminated metadata.
 * JSON-metadata surface only — `content.dropboxapi.com` binary endpoints cannot ride the managed proxy.
 */

/** All the JSON-RPC file endpoints live under this host. */
export const DROPBOX_API_BASE = 'https://api.dropboxapi.com/2';

/** Dropbox authenticates with an OAuth2 bearer access token, attached by the transport. */
export const dropboxAuth: OAuth2Scheme = {
  type: 'oauth2',
  scopes: ['files.metadata.read', 'files.content.read', 'files.content.write'],
};

/** A Dropbox metadata entry; `.tag` (`file` | `folder` | `deleted`) is a literal key in Dropbox's JSON. */
export interface DropboxEntry {
  ['.tag']?: string;
  name: string;
  id?: string;
  path_lower?: string;
  path_display?: string;
  /** Files only — size in bytes. */
  size?: number;
  client_modified?: string;
  server_modified?: string;
  rev?: string;
  content_hash?: string;
}

/** The `list_folder` / `list_folder/continue` envelope. */
export interface DropboxListFolderResult {
  entries: DropboxEntry[];
  cursor?: string;
  has_more?: boolean;
}

/** One `search_v2` match — the entry is nested under `metadata.metadata`. */
export interface DropboxSearchMatch {
  metadata?: { metadata?: DropboxEntry };
}

/** The `search_v2` envelope. */
export interface DropboxSearchResult {
  matches: DropboxSearchMatch[];
  has_more?: boolean;
  cursor?: string;
}

/** The `get_temporary_link` envelope — a short-lived direct download URL + metadata. */
export interface DropboxTemporaryLink {
  metadata: DropboxEntry;
  link: string;
}

const DEFAULT_MAX_PAGES = 50;

/** Hand-rolled `list_folder` paging: Dropbox advances by POSTing the cursor to a DIFFERENT endpoint. */
export async function listFolderPaged(
  http: HttpClient,
  auth: AuthHandle,
  body: Record<string, JsonValue>,
  maxItems: number,
  maxPages: number = DEFAULT_MAX_PAGES,
): Promise<DropboxEntry[]> {
  const collected: DropboxEntry[] = [];
  let res = await http.post<DropboxListFolderResult>(`${DROPBOX_API_BASE}/files/list_folder`, { auth, body });
  for (let page = 0; ; page += 1) {
    collected.push(...(res.data.entries ?? []));
    if (collected.length >= maxItems) return collected.slice(0, maxItems);
    if (!res.data.has_more || !res.data.cursor) return collected;
    if (page + 1 >= maxPages) {
      throw new ActionError({
        code: 'pagination_limit',
        message: `Dropbox list_folder exceeded ${maxPages} pages — aborting to avoid an unbounded loop`,
        retryable: false,
      });
    }
    res = await http.post<DropboxListFolderResult>(`${DROPBOX_API_BASE}/files/list_folder/continue`, {
      auth,
      body: { cursor: res.data.cursor },
    });
  }
}
