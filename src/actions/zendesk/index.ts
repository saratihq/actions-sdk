export { type ZendeskTicket, type ZendeskUser, zendeskAuth, zendeskBaseUrl } from './common';
export {
  CREATE_TICKET_TYPE,
  createTicket,
  GET_TICKET_TYPE,
  getTicket,
  LIST_TICKETS_TYPE,
  listTickets,
  UPDATE_TICKET_TYPE,
  updateTicket,
} from './tickets';
export { LIST_USERS_TYPE, listUsers, SEARCH_TYPE, search } from './other';
export { NEW_TICKET_TYPE, newTicket, type ZendeskTicketEvent } from './new-ticket.polling';

import { listUsers, search } from './other';
import { createTicket, getTicket, listTickets, updateTicket } from './tickets';

/** Every Zendesk action, for catalog builds and registration. */
export const zendeskActions = [
  createTicket,
  getTicket,
  updateTicket,
  listTickets,
  search,
  listUsers,
] as const;
