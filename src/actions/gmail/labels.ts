import { defineAction } from '../../core/action';
import { buildRawMessage, GMAIL_API_BASE, type GmailLabel, gmailAuth, listGmailLabels } from './common';
import { longText, shortText } from '../../core/props';

/** Public action type ids. */
export const LIST_LABELS_TYPE = 'gmail.list_labels';
export const CREATE_DRAFT_TYPE = 'gmail.create_draft';

/** List labels; also underpins the label picker on `list_messages`. */
export const listLabels = defineAction({
  type: LIST_LABELS_TYPE,
  name: 'List labels',
  description: 'List the labels in the connected Gmail account.',
  auth: gmailAuth,
  props: {},
  async run({ auth, http }): Promise<{ labels: GmailLabel[]; count: number }> {
    const labels = await listGmailLabels(http, auth);
    return { labels, count: labels.length };
  },
});

/** The create-draft response. */
export interface GmailDraft {
  id: string;
  message: { id: string; threadId: string };
}

/** Create a draft email (assembled the same way as send, but not sent). */
export const createDraft = defineAction({
  type: CREATE_DRAFT_TYPE,
  name: 'Create draft',
  description: 'Create a draft email in the connected Gmail account.',
  auth: gmailAuth,
  props: {
    to: shortText<true>({ label: 'To', required: true }),
    subject: shortText<true>({ label: 'Subject', required: true }),
    body: longText<true>({ label: 'Body', required: true }),
  },
  async run({ auth, props, http }): Promise<GmailDraft> {
    const raw = buildRawMessage({ to: props.to, subject: props.subject, body: props.body });
    const res = await http.post<GmailDraft>(`${GMAIL_API_BASE}/drafts`, {
      auth,
      body: { message: { raw } },
    });
    return res.data;
  },
});
