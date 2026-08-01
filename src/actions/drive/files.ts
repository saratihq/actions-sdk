import { defineAction } from '../../core/action';
import { cursorInBody, paginate } from '../../core/http/pagination';
import { number, shortText } from '../../core/props';
import { DRIVE_FILE_FIELDS, DRIVE_FILES_URL, DRIVE_FOLDER_MIME, type DriveFile, driveAuth } from './common';

/** Public catalog ids — underscore form, since the action namespace forbids hyphens. */
export const LIST_FILES_TYPE = 'drive.list_files';
export const GET_FILE_TYPE = 'drive.get_file';
export const CREATE_FOLDER_TYPE = 'drive.create_folder';

/** List or search Drive files; a `query` is passed through as a raw Drive `q`, paged to `limit`. */
export const listFiles = defineAction({
  type: LIST_FILES_TYPE,
  name: 'List files',
  description: 'List or search files in Google Drive.',
  auth: driveAuth,
  props: {
    query: shortText({
      label: 'Query',
      description: "Drive search, e.g. name contains 'report' and mimeType='application/pdf'.",
      required: false,
    }),
    limit: number({ label: 'Max results', required: false, defaultValue: 100 }),
  },
  async run({ auth, props, http }): Promise<{ files: DriveFile[]; count: number }> {
    const files = await paginate<DriveFile>({
      http,
      auth,
      url: DRIVE_FILES_URL,
      query: {
        q: props.query && props.query.trim() ? props.query : 'trashed=false',
        pageSize: 100,
        orderBy: 'modifiedTime desc',
        fields: `nextPageToken,files(${DRIVE_FILE_FIELDS})`,
        // Include shared drives, not just My Drive, in the listing + traversal.
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      },
      extractItems: (res) => (res.data as { files?: DriveFile[] }).files ?? [],
      nextPage: cursorInBody({ cursorPath: ['nextPageToken'], cursorParam: 'pageToken' }),
      maxItems: props.limit ?? 100,
    });
    return { files, count: files.length };
  },
});

/** Get a file or folder's metadata by id. Read-only. */
export const getFile = defineAction({
  type: GET_FILE_TYPE,
  name: 'Get file',
  description: 'Get a Google Drive file or folder’s metadata by id.',
  auth: driveAuth,
  props: {
    fileId: shortText<true>({ label: 'File id', required: true }),
  },
  async run({ auth, props, http }): Promise<DriveFile> {
    const res = await http.get<DriveFile>(`${DRIVE_FILES_URL}/${encodeURIComponent(props.fileId)}`, {
      auth,
      // supportsAllDrives so an id that lives on a shared drive resolves (else 404).
      query: { fields: DRIVE_FILE_FIELDS, supportsAllDrives: true },
    });
    return res.data;
  },
});

/** Create a folder, optionally inside a parent folder. JSON metadata only. */
export const createFolder = defineAction({
  type: CREATE_FOLDER_TYPE,
  name: 'Create folder',
  description: 'Create a folder in Google Drive.',
  auth: driveAuth,
  props: {
    name: shortText<true>({ label: 'Name', required: true }),
    parentId: shortText({
      label: 'Parent folder id',
      description: 'Create inside this folder; omit for the root.',
      required: false,
    }),
  },
  async run({ auth, props, http }): Promise<DriveFile> {
    const res = await http.post<DriveFile>(DRIVE_FILES_URL, {
      auth,
      // supportsAllDrives so a shared-drive parent is accepted (else 404).
      query: { fields: DRIVE_FILE_FIELDS, supportsAllDrives: true },
      body: {
        name: props.name,
        mimeType: DRIVE_FOLDER_MIME,
        ...(props.parentId ? { parents: [props.parentId] } : {}),
      },
    });
    return res.data;
  },
});
