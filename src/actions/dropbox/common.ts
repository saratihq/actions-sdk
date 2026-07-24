import type { AuthHandle, OAuth2Scheme } from '../../core/auth';
import { ActionError } from '../../core/errors';
import type { HttpClient } from '../../core/http/client';
import type { JsonValue } from '../../core/http/types';

/**
 * Shared Dropbox (API v2) building blocks: the `/2/files/*` RPC endpoints, OAuth2
 * Bearer auth, the JSON request/response envelopes, and the `.tag`-discriminated
 * metadata shape are Dropbox's public contract.
 *
 * MANAGED-FILE LIMITATION: Dropbox splits its API across two hosts —
 * `api.dropboxapi.com` for JSON RPC (list/metadata/search/create-folder/
 * temporary-link) and `content.dropboxapi.com` for the binary upload/download
 * endpoints (`/files/upload`, `/files/download`), which carry the file bytes in
 * the body with a `Dropbox-API-Arg` header. The managed proxy carries JSON only,
 * so those content endpoints can't ride the managed transport. These actions
 * therefore cover the JSON-metadata surface only — no binary upload/download.
 * `get_temporary_link` returns a short-lived direct download URL (JSON), which is
 * the managed-safe way to hand a caller a file's contents.
 */

/** All the JSON-RPC file endpoints live under this host. */
export const DROPBOX_API_BASE = 'https://api.dropboxapi.com/2';

/** Dropbox authenticates with an OAuth2 bearer access token, attached by the transport. */
export const dropboxAuth: OAuth2Scheme = {
  type: 'oauth2',
  scopes: ['files.metadata.read', 'files.content.read', 'files.content.write'],
};

/**
 * A Dropbox file/folder metadata entry, trimmed to the fields reads surface. The
 * `.tag` discriminator (`file` | `folder` | `deleted`) is a literal key in
 * Dropbox's JSON, so it is quoted here.
 */
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

/**
 * Follow Dropbox's cursor pagination for `list_folder`. Unlike a query-cursor API,
 * Dropbox advances by POSTing the cursor to a DIFFERENT endpoint
 * (`/files/list_folder/continue`), so the generic `paginate` helper (GET + query
 * cursor) doesn't fit — this is the small hand-rolled loop it calls for instead.
 * Bounded by `maxItems` and a hard page cap so a runaway cursor can't loop forever.
 */
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
