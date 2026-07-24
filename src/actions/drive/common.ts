import type { OAuth2Scheme } from '../../core/auth';

/**
 * Shared Google Drive (API v3) building blocks: the `/drive/v3/files` endpoints,
 * OAuth2 Bearer auth, the `q` search grammar, and the `files` envelope.
 *
 * Managed-file limitation: the managed proxy carries JSON only, so uploading or
 * downloading file CONTENT (`alt=media`, multipart `uploadType`) cannot go over
 * the managed transport. These actions therefore cover the JSON-metadata surface
 * only — list/search, get metadata, create a folder. Binary upload/download needs
 * a direct (bring-your-own) connection.
 */

export const DRIVE_FILES_URL = 'https://www.googleapis.com/drive/v3/files';
export const DRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder';

/** The metadata fields requested/returned for a file. */
export const DRIVE_FILE_FIELDS = 'id,name,mimeType,modifiedTime,size,webViewLink,parents';

/** Drive authenticates with an OAuth2 bearer access token, attached by the transport. */
export const driveAuth: OAuth2Scheme = {
  type: 'oauth2',
  scopes: ['https://www.googleapis.com/auth/drive'],
};

/** A Drive file's metadata (the fields {@link DRIVE_FILE_FIELDS} requests). */
export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  size?: string;
  webViewLink?: string;
  parents?: string[];
}
