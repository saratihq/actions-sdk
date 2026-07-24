export {
  buildRawMessage,
  buildSearchQuery,
  GMAIL_API_BASE,
  type GmailLabel,
  type GmailMessageRef,
  type GmailProfile,
  gmailAuth,
  labelOptions,
  listGmailLabels,
} from './common';
export {
  findEmail,
  GET_EMAIL_TYPE,
  GET_PROFILE_TYPE,
  getEmail,
  getProfile,
  type GmailMessage,
  type GmailSendResult,
  LIST_MESSAGES_TYPE,
  listMessages,
  SEARCH_EMAIL_TYPE,
  SEND_EMAIL_TYPE,
  sendEmail,
} from './messages';
export { CREATE_DRAFT_TYPE, createDraft, type GmailDraft, LIST_LABELS_TYPE, listLabels } from './labels';
export { GMAIL_NEW_EMAIL_TYPE, newEmail, type GmailNewEmailEvent } from './new-email.polling';

import { createDraft, listLabels } from './labels';
import { findEmail, getEmail, getProfile, listMessages, sendEmail } from './messages';

/** Every Gmail action, for catalog builds and registration. */
export const gmailActions = [
  getProfile,
  listMessages,
  findEmail,
  getEmail,
  sendEmail,
  listLabels,
  createDraft,
] as const;
