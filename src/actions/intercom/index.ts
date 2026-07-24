export {
  adminOptions,
  INTERCOM_API_BASE,
  type IntercomAdmin,
  type IntercomContact,
  type IntercomList,
  intercomAuth,
  listIntercomAdmins,
} from './common';
export {
  CREATE_CONTACT_TYPE,
  createContact,
  GET_CONTACT_TYPE,
  getContact,
  LIST_CONTACTS_TYPE,
  listContacts,
  SEARCH_CONTACTS_TYPE,
  searchContacts,
} from './contacts';
export {
  type IntercomConversation,
  LIST_ADMINS_TYPE,
  LIST_CONVERSATIONS_TYPE,
  listAdmins,
  listConversations,
} from './other';

export {
  NEW_CONVERSATION_TYPE,
  newConversation,
  type IntercomConversationEvent,
} from './new-conversation.polling';

import { createContact, getContact, listContacts, searchContacts } from './contacts';
import { listAdmins, listConversations } from './other';

/** Every Intercom action, for catalog builds and registration. */
export const intercomActions = [
  listContacts,
  getContact,
  createContact,
  searchContacts,
  listConversations,
  listAdmins,
] as const;
