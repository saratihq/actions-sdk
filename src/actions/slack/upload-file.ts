import { defineAction } from '../../core/action';
import { ActionError } from '../../core/errors';
import { file, shortText } from '../../core/props';
import { assertSlackOk, SLACK_API_BASE, slackOAuth, type SlackEnvelope } from './common';

/** Public type for the file-upload action. */
export const UPLOAD_FILE_TYPE = 'slack.upload_file';

interface UploadUrlResponse extends SlackEnvelope {
  upload_url?: string;
  file_id?: string;
}

export interface CompleteUploadResponse extends SlackEnvelope {
  files?: Array<{ id: string; title?: string }>;
}

/**
 * Upload a file to a Slack channel: reserve an upload URL, POST the bytes, complete the upload.
 * The multipart step carries raw bytes, so this needs a direct connection — the JSON-only managed proxy fails.
 */
export const uploadFile = defineAction({
  type: UPLOAD_FILE_TYPE,
  name: 'Upload a file',
  description: 'Upload a file to a Slack channel (from an upstream file-producing step).',
  auth: slackOAuth,
  props: {
    channel: shortText({
      label: 'Channel',
      description: 'The channel id to share the file into (e.g. C0123ABC).',
      required: true,
    }),
    file: file({
      label: 'File',
      description: 'The file to upload — typically {{step.file}} from a download/produce step.',
      required: true,
    }),
    title: shortText({
      label: 'Title',
      description: 'Optional title shown in Slack (defaults to the filename).',
      required: false,
    }),
  },
  async run({ auth, props, http }): Promise<CompleteUploadResponse> {
    // 1) Reserve an upload URL for these exact bytes.
    const reserved = await http.get<UploadUrlResponse>(`${SLACK_API_BASE}/files.getUploadURLExternal`, {
      auth,
      query: { filename: props.file.filename, length: props.file.data.byteLength },
    });
    const { upload_url: uploadUrl, file_id: fileId } = assertSlackOk(reserved.data);
    if (!uploadUrl || !fileId) {
      throw new ActionError({
        code: 'provider_error',
        message: 'Slack did not return an upload URL',
        status: 502,
        retryable: true,
        detail: { provider: 'slack' },
      });
    }

    // 2) The multipart upload itself — raw bytes over the wire (direct transport only).
    await http.post(uploadUrl, {
      auth,
      multipart: {
        files: {
          file: {
            filename: props.file.filename,
            data: props.file.data,
            ...(props.file.mimeType ? { mimeType: props.file.mimeType } : {}),
          },
        },
      },
    });

    // 3) Finalise: attach the uploaded file to the channel.
    const completed = await http.post<CompleteUploadResponse>(
      `${SLACK_API_BASE}/files.completeUploadExternal`,
      {
        auth,
        body: {
          files: [{ id: fileId, title: props.title ?? props.file.filename }],
          channel_id: props.channel,
        },
      },
    );
    return assertSlackOk(completed.data);
  },
});
