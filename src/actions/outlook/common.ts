import type { OAuth2Scheme } from '../../core/auth';
import type { NextPageFn } from '../../core/http/pagination';
import type { JsonValue } from '../../core/http/types';

/**
 * Shared Outlook (Microsoft Graph v1.0) building blocks: the `/me/messages`,
 * `/me/mailFolders`, and `/me/sendMail` endpoints, the `@odata.nextLink` cursor,
 * and the `{ message: { body, toRecipients } }` send shape from Microsoft Graph's
 * public API.
 *
 * Auth shape: Microsoft Graph authenticates with a standard
 * `Authorization: Bearer <token>` over HTTPS — the same shape as every other
 * oauth2 app in this SDK. The actions never set the header; the transport does.
 * Over the managed transport the proxy strips the (absent) auth header and
 * injects the connection's real Graph token server-side, keyed by the managed
 * connection reference — identical handling to Google/Slack.
 */

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

/**
 * `@odata.nextLink` pagination (Microsoft Graph): the body carries a fully-formed
 * absolute URL for the next page, or nothing on the last page. Returned verbatim,
 * like a Link-header `next`.
 */
export const odataNextLink: NextPageFn = (response) => {
  const next = (response.data as { ['@odata.nextLink']?: unknown })['@odata.nextLink'];
  return typeof next === 'string' && next.length > 0 ? next : null;
};

/**
 * Parse a comma/semicolon-separated address list into Graph's recipient shape.
 * Empty entries are dropped; a blank input yields an empty array (the caller
 * decides whether that field is required).
 */
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
