import { defineTrigger } from '../../core/trigger';
import type { HttpClient } from '../../core/http/client';
import type { AuthHandle } from '../../core/auth';
import { checkbox, shortText } from '../../core/props';
import { DROPBOX_API_BASE, type DropboxEntry, type DropboxListFolderResult, dropboxAuth } from './common';

/**
 * Fires for each file added under a folder after the trigger is enabled. Polling, not webhooks: Dropbox
 * webhooks are app-level and carry only changed account ids, so there is nothing to register per connection.
 */
export const DROPBOX_NEW_FILE_TYPE = 'dropbox.new_file';

/** Hard cap on continue-pages per poll so a runaway cursor can't loop forever. */
const MAX_PAGES = 50;
/** Store key for the persisted delta cursor. */
const CURSOR_KEY = 'deltaCursor';

/** A normalised new-file event — trimmed to the fields a workflow reads. */
export interface DropboxFileEvent {
  /** Dropbox file id (`id:…`). */
  id: string;
  name: string;
  pathLower: string;
  pathDisplay: string;
  /** Size in bytes. */
  size?: number;
  /** ISO 8601 server-side modification time. */
  serverModified?: string;
  /** Revision — changes on every new upload of the same path. */
  rev?: string;
  contentHash?: string;
}

interface LatestCursorResult {
  cursor?: string;
}

/** Map a Dropbox file metadata entry to the normalised event. */
function toEvent(entry: DropboxEntry): DropboxFileEvent {
  return {
    id: entry.id ?? '',
    name: entry.name,
    pathLower: entry.path_lower ?? '',
    pathDisplay: entry.path_display ?? '',
    ...(entry.size !== undefined ? { size: entry.size } : {}),
    ...(entry.server_modified ? { serverModified: entry.server_modified } : {}),
    ...(entry.rev ? { rev: entry.rev } : {}),
    ...(entry.content_hash ? { contentHash: entry.content_hash } : {}),
  };
}

/** Follow `list_folder/continue` from `cursor`, collecting file entries; returns the entries + the advanced cursor. */
async function drainChanges(
  http: HttpClient,
  auth: AuthHandle,
  cursor: string,
): Promise<{ entries: DropboxEntry[]; cursor: string }> {
  const collected: DropboxEntry[] = [];
  let next = cursor;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const res = await http.post<DropboxListFolderResult>(`${DROPBOX_API_BASE}/files/list_folder/continue`, {
      auth,
      body: { cursor: next },
    });
    collected.push(...(res.data.entries ?? []));
    next = res.data.cursor ?? next;
    if (!res.data.has_more) break;
  }
  return { entries: collected, cursor: next };
}

export const newFile = defineTrigger({
  type: DROPBOX_NEW_FILE_TYPE,
  strategy: 'polling',
  name: 'New file',
  description: 'Fires when a file is added to a Dropbox folder.',
  auth: dropboxAuth,
  props: {
    path: shortText({
      label: 'Folder path',
      description: 'Folder to watch, e.g. /Invoices. Empty for the account root.',
      required: false,
    }),
    recursive: checkbox({
      label: 'Include subfolders',
      description: 'Also fire for files added in nested folders.',
      required: false,
      defaultValue: true,
    }),
  },
  sampleData: {
    id: 'id:a4ayc_80_OEAAAAAAAAAYa',
    name: 'Prime_Numbers.txt',
    pathLower: '/homework/math/prime_numbers.txt',
    pathDisplay: '/Homework/math/Prime_Numbers.txt',
    size: 7212,
    serverModified: '2026-07-20T15:50:38Z',
    rev: '015c7f...',
    contentHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  },
  async poll({ auth, props, http, store }): Promise<DropboxFileEvent[]> {
    const recursive = props.recursive ?? true;
    const path = props.path ?? '';

    const stored = await store.get<string>(CURSOR_KEY);
    // First activation baselines via get_latest_cursor, so only files added after enabling ever fire.
    if (!stored) {
      const res = await http.post<LatestCursorResult>(
        `${DROPBOX_API_BASE}/files/list_folder/get_latest_cursor`,
        { auth, body: { path, recursive, include_deleted: false } },
      );
      if (res.data.cursor) await store.set(CURSOR_KEY, res.data.cursor);
      return [];
    }

    const { entries, cursor } = await drainChanges(http, auth, stored);
    await store.set(CURSOR_KEY, cursor);
    return entries.filter((entry) => entry['.tag'] === 'file').map(toEvent);
  },
  // Keying on id:rev fires a genuine new revision while suppressing a re-delivery of the same one.
  dedupeKey: (event): string => `${event.id}:${event.rev ?? ''}`,
});
