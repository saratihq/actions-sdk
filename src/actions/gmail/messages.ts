import { defineAction } from '../../core/action';
import { cursorInBody, paginate } from '../../core/http/pagination';
import type { JsonValue } from '../../core/http/types';
import { dropdown, longText, multiSelect, number, shortText } from '../../core/props';
import {
  buildRawMessage,
  buildSearchQuery,
  GMAIL_API_BASE,
  type GmailMessageRef,
  type GmailProfile,
  gmailAuth,
  labelOptions,
} from './common';

/** Public catalog ids — stable; existing plans reference them verbatim. */
export const GET_PROFILE_TYPE = 'gmail.get_profile';
export const LIST_MESSAGES_TYPE = 'gmail.list_messages';
export const GET_EMAIL_TYPE = 'gmail.gmail_get_mail';
export const SEND_EMAIL_TYPE = 'gmail.send_email';
export const SEARCH_EMAIL_TYPE = 'gmail.gmail_search_mail';

/** A full Gmail message (as returned by `get` with `format=full`). */
export interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  payload?: JsonValue;
  internalDate?: string;
}

/** The send response (message id + thread + applied labels). */
export interface GmailSendResult {
  id: string;
  threadId: string;
  labelIds?: string[];
}

/** Retrieve the mailbox profile. No inputs — the benign live-smoke action for Gmail. */
export const getProfile = defineAction({
  type: GET_PROFILE_TYPE,
  name: 'Get profile',
  description: 'Retrieve the connected Gmail mailbox profile.',
  auth: gmailAuth,
  props: {},
  async run({ auth, http }): Promise<GmailProfile> {
    const res = await http.get<GmailProfile>(`${GMAIL_API_BASE}/profile`, { auth });
    return res.data;
  },
});

/** List message ids matching a Gmail search query, following `nextPageToken` up to `limit`. */
export const listMessages = defineAction({
  type: LIST_MESSAGES_TYPE,
  name: 'List messages',
  description: 'List Gmail message ids matching a query.',
  auth: gmailAuth,
  props: {
    query: shortText({
      label: 'Query',
      description: 'Gmail search, e.g. from:boss is:unread.',
      required: false,
    }),
    labelIds: multiSelect<string, false>({
      label: 'Labels',
      description: 'Restrict to these labels — loaded live.',
      required: false,
      options: ({ auth, http }) => labelOptions(http, auth),
    }),
    limit: number({ label: 'Max results', required: false, defaultValue: 100 }),
  },
  async run({ auth, props, http }): Promise<{ messages: GmailMessageRef[]; count: number }> {
    const messages = await paginate<GmailMessageRef>({
      http,
      auth,
      url: `${GMAIL_API_BASE}/messages`,
      query: {
        q: props.query,
        labelIds: props.labelIds,
        maxResults: 100,
      },
      extractItems: (res) => (res.data as { messages?: GmailMessageRef[] }).messages ?? [],
      nextPage: cursorInBody({ cursorPath: ['nextPageToken'], cursorParam: 'pageToken' }),
      maxItems: props.limit ?? 100,
    });
    return { messages, count: messages.length };
  },
});

/** Find emails by structured filters — the friendly-input sibling of {@link listMessages}. */
export const findEmail = defineAction({
  type: SEARCH_EMAIL_TYPE,
  name: 'Find email',
  description: 'Search Gmail by sender, recipient, subject, label or a raw query.',
  auth: gmailAuth,
  props: {
    from: shortText({ label: 'From', description: 'Sender address or name.', required: false }),
    to: shortText({ label: 'To', description: 'Recipient address or name.', required: false }),
    subject: shortText({ label: 'Subject', description: 'Words in the subject.', required: false }),
    query: shortText({
      label: 'Query',
      description: 'Extra raw Gmail search appended verbatim, e.g. is:unread newer_than:7d.',
      required: false,
    }),
    label: dropdown<string, false>({
      label: 'Label',
      description: 'Restrict to a single label — loaded live.',
      required: false,
      options: ({ auth, http }) => labelOptions(http, auth),
    }),
    max: number({ label: 'Max results', required: false, defaultValue: 10 }),
  },
  async run({ auth, props, http }): Promise<{ query: string; messages: GmailMessageRef[]; count: number }> {
    const q = buildSearchQuery({
      ...(props.from !== undefined ? { from: props.from } : {}),
      ...(props.to !== undefined ? { to: props.to } : {}),
      ...(props.subject !== undefined ? { subject: props.subject } : {}),
      ...(props.query !== undefined ? { query: props.query } : {}),
    });
    const messages = await paginate<GmailMessageRef>({
      http,
      auth,
      url: `${GMAIL_API_BASE}/messages`,
      query: {
        q: q || undefined,
        labelIds: props.label,
        maxResults: 100,
      },
      extractItems: (res) => (res.data as { messages?: GmailMessageRef[] }).messages ?? [],
      nextPage: cursorInBody({ cursorPath: ['nextPageToken'], cursorParam: 'pageToken' }),
      maxItems: props.max ?? 10,
    });
    return { query: q, messages, count: messages.length };
  },
});

/** Retrieve a single message. `format` controls how much is returned. */
export const getEmail = defineAction({
  type: GET_EMAIL_TYPE,
  name: 'Get email',
  description: 'Retrieve a Gmail message by id.',
  auth: gmailAuth,
  props: {
    messageId: shortText<true>({ label: 'Message id', required: true }),
    format: dropdown<string, false>({
      label: 'Format',
      required: false,
      defaultValue: 'full',
      options: [
        { label: 'Full', value: 'full' },
        { label: 'Metadata', value: 'metadata' },
        { label: 'Minimal', value: 'minimal' },
        { label: 'Raw', value: 'raw' },
      ],
    }),
  },
  async run({ auth, props, http }): Promise<GmailMessage> {
    const res = await http.get<GmailMessage>(
      `${GMAIL_API_BASE}/messages/${encodeURIComponent(props.messageId)}`,
      { auth, query: { format: props.format ?? 'full' } },
    );
    return res.data;
  },
});

/** Send a plain-text email as a base64url-encoded RFC822 message in the JSON `raw` field. */
export const sendEmail = defineAction({
  type: SEND_EMAIL_TYPE,
  name: 'Send email',
  description: 'Send a plain-text email from the connected Gmail account.',
  auth: gmailAuth,
  props: {
    to: shortText<true>({ label: 'To', required: true }),
    subject: shortText<true>({ label: 'Subject', required: true }),
    body: longText<true>({ label: 'Body', required: true }),
    cc: shortText({ label: 'Cc', required: false }),
    bcc: shortText({ label: 'Bcc', required: false }),
  },
  async run({ auth, props, http }): Promise<GmailSendResult> {
    const raw = buildRawMessage({
      to: props.to,
      subject: props.subject,
      body: props.body,
      ...(props.cc !== undefined ? { cc: props.cc } : {}),
      ...(props.bcc !== undefined ? { bcc: props.bcc } : {}),
    });
    const res = await http.post<GmailSendResult>(`${GMAIL_API_BASE}/messages/send`, {
      auth,
      body: { raw },
    });
    return res.data;
  },
});
