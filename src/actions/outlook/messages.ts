import { defineAction } from '../../core/action';
import { paginate } from '../../core/http/pagination';
import type { QueryValue } from '../../core/http/types';
import { checkbox, longText, number, shortText } from '../../core/props';
import {
  buildSendMailBody,
  GRAPH_ME_BASE,
  MESSAGE_SELECT,
  odataNextLink,
  type OutlookMessage,
  outlookAuth,
} from './common';

/**
 * Public action type ids. The established Outlook catalog ids are hyphenated
 * (`send-email`) or camelCase (`findEmail`), which the action namespace forbids,
 * so these use underscore ids. Microsoft Graph uses the standard bearer transport,
 * so these actions are transport-agnostic.
 */
export const SEND_EMAIL_TYPE = 'outlook.send_email';
export const LIST_MESSAGES_TYPE = 'outlook.list_messages';
export const GET_MESSAGE_TYPE = 'outlook.get_message';

/** The synthesised result of the 202-Accepted send. */
export interface OutlookSendResult {
  sent: true;
}

/**
 * Send an email from the connected mailbox. `to`/`cc`/`bcc` accept a
 * comma-separated address list. Graph returns 202 Accepted with no body →
 * synthesised confirmation.
 */
export const sendEmail = defineAction({
  type: SEND_EMAIL_TYPE,
  name: 'Send email',
  description: 'Send an email from the connected Outlook mailbox.',
  auth: outlookAuth,
  props: {
    to: shortText<true>({ label: 'To', description: 'Comma-separated recipient addresses.', required: true }),
    subject: shortText<true>({ label: 'Subject', required: true }),
    body: longText<true>({ label: 'Body', required: true }),
    html: checkbox({
      label: 'HTML body',
      description: 'Send the body as HTML instead of plain text.',
      required: false,
      defaultValue: false,
    }),
    cc: shortText({ label: 'Cc', description: 'Comma-separated addresses.', required: false }),
    bcc: shortText({ label: 'Bcc', description: 'Comma-separated addresses.', required: false }),
  },
  async run({ auth, props, http }): Promise<OutlookSendResult> {
    const body = buildSendMailBody({
      to: props.to,
      subject: props.subject,
      body: props.body,
      ...(props.html !== undefined ? { html: props.html } : {}),
      ...(props.cc !== undefined ? { cc: props.cc } : {}),
      ...(props.bcc !== undefined ? { bcc: props.bcc } : {}),
    });
    await http.post(`${GRAPH_ME_BASE}/sendMail`, { auth, body });
    return { sent: true };
  },
});

/**
 * List messages, optionally within a folder and/or matching a free-text `search`,
 * following Graph's `@odata.nextLink` cursor up to `limit`. Graph returns messages
 * newest-first (`receivedDateTime` descending) by default, so no explicit
 * `$orderby` is sent — which also avoids URL-encoding a spaced OData value
 * (`+`-vs-`%20`) that Graph's parser might reject. `$search` additionally needs
 * the `ConsistencyLevel: eventual` header.
 */
export const listMessages = defineAction({
  type: LIST_MESSAGES_TYPE,
  name: 'List messages',
  description: 'List messages from the connected Outlook mailbox.',
  auth: outlookAuth,
  props: {
    folderId: shortText({
      label: 'Folder id',
      description: 'Restrict to a mail folder (id or well-known name like "inbox"). Blank = all messages.',
      required: false,
    }),
    search: shortText({ label: 'Search', description: 'Free-text search over messages.', required: false }),
    limit: number({ label: 'Max results', required: false, defaultValue: 25 }),
  },
  async run({ auth, props, http }): Promise<{ messages: OutlookMessage[]; count: number }> {
    const searching = props.search !== undefined && props.search.trim() !== '';
    const base =
      props.folderId && props.folderId.trim() !== ''
        ? `${GRAPH_ME_BASE}/mailFolders/${encodeURIComponent(props.folderId)}/messages`
        : `${GRAPH_ME_BASE}/messages`;
    const query: Record<string, QueryValue> = { $select: MESSAGE_SELECT, $top: 50 };
    if (searching) query.$search = `"${props.search!.trim()}"`;
    const messages = await paginate<OutlookMessage>({
      http,
      auth,
      url: base,
      query,
      // $search requires the eventual-consistency header.
      ...(searching ? { headers: { ConsistencyLevel: 'eventual' } } : {}),
      extractItems: (res) => (res.data as { value?: OutlookMessage[] }).value ?? [],
      nextPage: odataNextLink,
      maxItems: props.limit ?? 25,
    });
    return { messages, count: messages.length };
  },
});

/** Retrieve a single message by id. Read-only. */
export const getMessage = defineAction({
  type: GET_MESSAGE_TYPE,
  name: 'Get message',
  description: 'Retrieve an Outlook message by id.',
  auth: outlookAuth,
  props: {
    messageId: shortText<true>({ label: 'Message id', required: true }),
  },
  async run({ auth, props, http }): Promise<OutlookMessage> {
    const res = await http.get<OutlookMessage>(
      `${GRAPH_ME_BASE}/messages/${encodeURIComponent(props.messageId)}`,
      { auth, query: { $select: MESSAGE_SELECT } },
    );
    return res.data;
  },
});
