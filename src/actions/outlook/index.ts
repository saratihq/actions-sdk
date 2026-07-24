export {
  buildSendMailBody,
  GRAPH_ME_BASE,
  type GraphEmailAddress,
  type GraphRecipient,
  MESSAGE_SELECT,
  odataNextLink,
  type OutlookMailFolder,
  type OutlookMessage,
  outlookAuth,
  toRecipients,
} from './common';
export {
  GET_MESSAGE_TYPE,
  getMessage,
  LIST_MESSAGES_TYPE,
  listMessages,
  type OutlookSendResult,
  SEND_EMAIL_TYPE,
  sendEmail,
} from './messages';
export { LIST_FOLDERS_TYPE, listFolders } from './folders';
export { OUTLOOK_NEW_EMAIL_TYPE, newEmail, type OutlookNewEmailEvent } from './new-email.polling';

import { listFolders } from './folders';
import { getMessage, listMessages, sendEmail } from './messages';

/** Every Outlook (Microsoft Graph mail) action, for catalog builds and registration. */
export const outlookActions = [sendEmail, listMessages, getMessage, listFolders] as const;
