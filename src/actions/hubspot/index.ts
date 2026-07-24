export {
  HUBSPOT_API_BASE,
  type HubspotObject,
  type HubspotOwner,
  type HubspotPipeline,
  hubspotAuth,
  listDealPipelines,
  listHubspotOwners,
  ownerOptions,
  pipelineOptions,
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
  UPDATE_CONTACT_TYPE,
  updateContact,
} from './contacts';
export { CREATE_DEAL_TYPE, createDeal } from './deals';
export { LIST_OWNERS_TYPE, listOwners } from './owners';
export { NEW_CONTACT_TYPE, newContact, type HubspotContactEvent } from './new-contact.polling';

import { createContact, getContact, listContacts, searchContacts, updateContact } from './contacts';
import { createDeal } from './deals';
import { listOwners } from './owners';

/** Every HubSpot action, for catalog builds and registration. */
export const hubspotActions = [
  createContact,
  getContact,
  updateContact,
  listContacts,
  searchContacts,
  createDeal,
  listOwners,
] as const;
