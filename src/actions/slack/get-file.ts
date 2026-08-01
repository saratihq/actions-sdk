import { defineAction } from '../../core/action';
import { ActionError } from '../../core/errors';
import type { FileInput } from '../../core/props';
import { shortText } from '../../core/props';
import { assertSlackOk, SLACK_API_BASE, slackOAuth, type SlackEnvelope } from './common';

/** Public type for the file-download action. */
export const GET_FILE_TYPE = 'slack.get_file';

interface FilesInfoResponse extends SlackEnvelope {
  file?: {
    id: string;
    name?: string;
    mimetype?: string;
    size?: number;
    url_private?: string;
    url_private_download?: string;
  };
}

/** What downstream steps consume: the bytes as a {@link FileInput} plus Slack's metadata. */
export interface GetFileResult {
  file: FileInput;
  name: string;
  mimetype: string;
  size: number;
}

/**
 * Download a Slack file's bytes: `files.info` resolves the private URL, then a binary GET pulls the bytes.
 * The bytes need the direct transport — the JSON-only managed proxy fails here.
 */
export const getFile = defineAction({
  type: GET_FILE_TYPE,
  name: 'Download a file',
  description: 'Download a file from Slack by its file id, as bytes for a downstream step.',
  auth: slackOAuth,
  props: {
    fileId: shortText({
      label: 'File',
      description: 'The Slack file id (e.g. F0123ABC) — from a trigger event or an earlier step.',
      required: true,
    }),
  },
  async run({ auth, props, http }): Promise<GetFileResult> {
    const info = await http.get<FilesInfoResponse>(`${SLACK_API_BASE}/files.info`, {
      auth,
      query: { file: props.fileId },
    });
    const meta = assertSlackOk(info.data).file;
    const url = meta?.url_private_download ?? meta?.url_private;
    if (!meta || !url) {
      throw new ActionError({
        code: 'provider_error',
        message: `Slack file ${props.fileId} has no downloadable URL`,
        status: 400,
        retryable: false,
        detail: { provider: 'slack', fileId: props.fileId },
      });
    }

    const download = await http.get<Buffer>(url, { auth, responseType: 'binary' });
    if (!Buffer.isBuffer(download.data)) {
      throw new ActionError({
        code: 'provider_error',
        message: `Slack file ${props.fileId} did not return binary content`,
        status: 502,
        retryable: true,
      });
    }
    const filename = meta.name ?? props.fileId;
    const mimeType = meta.mimetype ?? 'application/octet-stream';
    return {
      file: { filename, data: download.data, mimeType },
      name: filename,
      mimetype: mimeType,
      size: download.data.byteLength,
    };
  },
});
