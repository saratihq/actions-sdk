import type { OAuth2Scheme } from '../../core/auth';
import type { NextPageFn } from '../../core/http/pagination';
import type { JsonValue } from '../../core/http/types';

/** Shared Outlook (Microsoft Graph v1.0) building blocks: `/me` endpoints, the `@odata.nextLink` cursor, send shape. */

export const GRAPH_ME_BASE = 'https://graph.microsoft.com/v1.0/me';

/** Outlook authenticates with an OAuth2 bearer access token (Microsoft identity), attached by the transport. */
export const outlookAuth: OAuth2Scheme = {
  type: 'oauth2',
  scopes: ['Mail.Read', 'Mail.Send', 'Mail.ReadWrite'],
};

/** A Graph email address (name + address). */
export interface GraphEmailAddress {
  name?: string;
  address?: string;
}

/** A Graph recipient wrapper. */
export interface GraphRecipient {
  emailAddress?: GraphEmailAddress;
}

/** An Outlook message, trimmed to the fields reads surface. */
export interface OutlookMessage {
  id: string;
  subject?: string;
  bodyPreview?: string;
  body?: { contentType?: string; content?: string };
  from?: GraphRecipient;
  toRecipients?: GraphRecipient[];
  ccRecipients?: GraphRecipient[];
  receivedDateTime?: string;
  sentDateTime?: string;
  isRead?: boolean;
  hasAttachments?: boolean;
  webLink?: string;
  conversationId?: string;
}

/** An Outlook mail folder. */
export interface OutlookMailFolder {
  id: string;
  displayName: string;
  parentFolderId?: string;
  childFolderCount?: number;
  unreadItemCount?: number;
  totalItemCount?: number;
}

/** The fields we `$select` for a message list/read. */
export const MESSAGE_SELECT =
  'id,subject,bodyPreview,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,isRead,hasAttachments,webLink,conversationId';

/** Graph pagination: `@odata.nextLink` is a fully-formed absolute URL, returned verbatim. */
export const odataNextLink: NextPageFn = (response) => {
  const next = (response.data as { ['@odata.nextLink']?: unknown })['@odata.nextLink'];
  return typeof next === 'string' && next.length > 0 ? next : null;
};

/** Parse a comma/semicolon-separated address list into Graph's recipient shape; blank yields `[]`. */
export function toRecipients(csv: string | undefined): Array<{ emailAddress: { address: string } }> {
  if (!csv) return [];
  return csv
    .split(/[,;]/)
    .map((address) => address.trim())
    .filter((address) => address.length > 0)
    .map((address) => ({ emailAddress: { address } }));
}

/** Build the Graph `sendMail` request body from the friendly props. */
export function buildSendMailBody(input: {
  to: string;
  subject: string;
  body: string;
  html?: boolean;
  cc?: string;
  bcc?: string;
  saveToSentItems?: boolean;
}): Record<string, JsonValue> {
  const message: Record<string, JsonValue> = {
    subject: input.subject,
    body: { contentType: input.html ? 'HTML' : 'Text', content: input.body },
    toRecipients: toRecipients(input.to),
  };
  const cc = toRecipients(input.cc);
  const bcc = toRecipients(input.bcc);
  if (cc.length > 0) message.ccRecipients = cc;
  if (bcc.length > 0) message.bccRecipients = bcc;
  return { message, saveToSentItems: input.saveToSentItems ?? true };
}
