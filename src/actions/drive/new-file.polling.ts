import { defineTrigger } from '../../core/trigger';
import { cursorInBody, paginate } from '../../core/http/pagination';
import { shortText } from '../../core/props';
import { DRIVE_FILES_URL, driveAuth } from './common';

/**
 * Fires for each file created after the trigger is enabled. Polling, not push: Drive's `files.watch`
 * body is empty, carries no HMAC, and its channels expire and would need renewal.
 */
export const DRIVE_NEW_FILE_TYPE = 'drive.new_file';

/** Re-scan overlap (2 min) so a file created mid-poll is never missed; dedupe kills the double. */
const OVERLAP_MS = 120_000;
/** Hard cap on files collected per poll — bounds a burst without unbounded paging. */
const MAX_PER_POLL = 1000;
/** The metadata fields requested/returned — includes `createdTime`, which the shared list fields omit. */
const FILE_FIELDS = 'id,name,mimeType,createdTime,modifiedTime,webViewLink,parents';

/** A normalised new-file event — trimmed to the fields a workflow reads. */
export interface DriveFileEvent {
  id: string;
  name: string;
  mimeType: string;
  /** ISO 8601 (RFC 3339) creation time. */
  createdTime: string;
  modifiedTime?: string;
  webViewLink?: string;
  parents?: string[];
}

/** A Drive file as `files.list` returns it (the fields we request). */
interface DriveListFile {
  id?: string;
  name?: string;
  mimeType?: string;
  createdTime?: string;
  modifiedTime?: string;
  webViewLink?: string;
  parents?: string[];
}

interface DriveListEnvelope {
  files?: DriveListFile[];
  nextPageToken?: string;
}

/** Escape a single quote for embedding in a Drive `q` string literal. */
function escapeQ(value: string): string {
  return value.replace(/'/g, "\\'");
}

export const newFile = defineTrigger({
  type: DRIVE_NEW_FILE_TYPE,
  strategy: 'polling',
  name: 'New file',
  description: 'Fires when a file is created in Google Drive.',
  auth: driveAuth,
  props: {
    folderId: shortText({
      label: 'Folder id',
      description: 'Optional — only fire for files created directly in this folder.',
      required: false,
    }),
  },
  sampleData: {
    id: '1AbCdEfGhIjKlMnOpQrStUvWxYz',
    name: 'Q3 Report.pdf',
    mimeType: 'application/pdf',
    createdTime: '2026-07-20T10:00:00.000Z',
    modifiedTime: '2026-07-20T10:00:00.000Z',
    webViewLink: 'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz/view',
    parents: ['0BwFolderId'],
  },
  async poll({ auth, props, http, lastPolledAt }): Promise<DriveFileEvent[]> {
    // First activation baselines the watermark rather than backfilling existing files.
    if (!lastPolledAt) return [];

    const cutoff = new Date(Date.parse(lastPolledAt) - OVERLAP_MS).toISOString();
    const clauses = [`trashed = false`, `createdTime > '${cutoff}'`];
    if (props.folderId) clauses.push(`'${escapeQ(props.folderId)}' in parents`);

    const files = await paginate<DriveListFile>({
      http,
      auth,
      url: DRIVE_FILES_URL,
      query: {
        q: clauses.join(' and '),
        orderBy: 'createdTime desc',
        pageSize: 100,
        fields: `nextPageToken, files(${FILE_FIELDS})`,
        // Include shared drives so a file created there also fires the trigger.
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      },
      extractItems: (res) => (res.data as DriveListEnvelope).files ?? [],
      nextPage: cursorInBody({ cursorPath: ['nextPageToken'], cursorParam: 'pageToken' }),
      maxItems: MAX_PER_POLL,
    });

    return files
      .filter((file): file is DriveListFile & { id: string } => typeof file.id === 'string')
      .map((file) => ({
        id: file.id,
        name: file.name ?? '',
        mimeType: file.mimeType ?? '',
        createdTime: file.createdTime ?? '',
        ...(file.modifiedTime ? { modifiedTime: file.modifiedTime } : {}),
        ...(file.webViewLink ? { webViewLink: file.webViewLink } : {}),
        ...(file.parents ? { parents: file.parents } : {}),
      }));
  },
  dedupeKey: (event): string => event.id,
});
