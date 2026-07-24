import { defineAction } from '../../core/action';
import { paginate } from '../../core/http/pagination';
import type { JsonValue } from '../../core/http/types';
import { dropdown, longText, number, shortText } from '../../core/props';
import { subdomainProp, type ZendeskTicket, zendeskAuth, zendeskBaseUrl, zendeskNextPage } from './common';

/** Public types — stable public catalog ids. */
export const CREATE_TICKET_TYPE = 'zendesk.create_ticket';
export const GET_TICKET_TYPE = 'zendesk.get_ticket';
export const UPDATE_TICKET_TYPE = 'zendesk.update_ticket';
export const LIST_TICKETS_TYPE = 'zendesk.list_tickets';

const PRIORITY_OPTIONS = [
  { label: 'Urgent', value: 'urgent' },
  { label: 'High', value: 'high' },
  { label: 'Normal', value: 'normal' },
  { label: 'Low', value: 'low' },
];

const STATUS_OPTIONS = [
  { label: 'New', value: 'new' },
  { label: 'Open', value: 'open' },
  { label: 'Pending', value: 'pending' },
  { label: 'Hold', value: 'hold' },
  { label: 'Solved', value: 'solved' },
  { label: 'Closed', value: 'closed' },
];

/** Split a comma-separated tag string into an array. */
function splitTags(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const tags = value
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  return tags.length > 0 ? tags : undefined;
}

/** Create a ticket. The first comment is the ticket body. */
export const createTicket = defineAction({
  type: CREATE_TICKET_TYPE,
  name: 'Create ticket',
  description: 'Create a Zendesk ticket.',
  auth: zendeskAuth,
  props: {
    subdomain: subdomainProp(),
    subject: shortText<true>({ label: 'Subject', required: true }),
    comment: longText<true>({ label: 'Comment', description: 'The ticket body.', required: true }),
    priority: dropdown<string, false>({ label: 'Priority', required: false, options: PRIORITY_OPTIONS }),
    requesterEmail: shortText({ label: 'Requester email', required: false }),
    tags: shortText({ label: 'Tags', description: 'Comma-separated.', required: false }),
  },
  async run({ auth, props, http }): Promise<ZendeskTicket> {
    const ticket: Record<string, JsonValue> = {
      subject: props.subject,
      comment: { body: props.comment },
    };
    if (props.priority !== undefined) ticket.priority = props.priority;
    if (props.requesterEmail !== undefined) ticket.requester = { email: props.requesterEmail };
    const tags = splitTags(props.tags);
    if (tags) ticket.tags = tags;
    const res = await http.post<{ ticket: ZendeskTicket }>(
      `${zendeskBaseUrl(props.subdomain)}/tickets.json`,
      {
        auth,
        body: { ticket },
      },
    );
    return res.data.ticket;
  },
});

/** Retrieve a single ticket by id. Read-only. */
export const getTicket = defineAction({
  type: GET_TICKET_TYPE,
  name: 'Get ticket',
  description: 'Retrieve a Zendesk ticket by id.',
  auth: zendeskAuth,
  props: {
    subdomain: subdomainProp(),
    ticketId: number({ label: 'Ticket id', required: true }),
  },
  async run({ auth, props, http }): Promise<ZendeskTicket> {
    const res = await http.get<{ ticket: ZendeskTicket }>(
      `${zendeskBaseUrl(props.subdomain)}/tickets/${props.ticketId}.json`,
      { auth },
    );
    return res.data.ticket;
  },
});

/** Update a ticket — status, priority, assignee, or append a comment. */
export const updateTicket = defineAction({
  type: UPDATE_TICKET_TYPE,
  name: 'Update ticket',
  description: 'Update a Zendesk ticket.',
  auth: zendeskAuth,
  props: {
    subdomain: subdomainProp(),
    ticketId: number({ label: 'Ticket id', required: true }),
    status: dropdown<string, false>({ label: 'Status', required: false, options: STATUS_OPTIONS }),
    priority: dropdown<string, false>({ label: 'Priority', required: false, options: PRIORITY_OPTIONS }),
    assigneeId: number({ label: 'Assignee id', required: false }),
    comment: longText({ label: 'Comment', description: 'Append a comment.', required: false }),
    publicComment: dropdown<string, false>({
      label: 'Comment visibility',
      required: false,
      defaultValue: 'public',
      options: [
        { label: 'Public', value: 'public' },
        { label: 'Internal note', value: 'internal' },
      ],
    }),
  },
  async run({ auth, props, http }): Promise<ZendeskTicket> {
    const ticket: Record<string, JsonValue> = {};
    if (props.status !== undefined) ticket.status = props.status;
    if (props.priority !== undefined) ticket.priority = props.priority;
    if (props.assigneeId !== undefined) ticket.assignee_id = props.assigneeId;
    if (props.comment !== undefined) {
      ticket.comment = { body: props.comment, public: (props.publicComment ?? 'public') === 'public' };
    }
    const res = await http.put<{ ticket: ZendeskTicket }>(
      `${zendeskBaseUrl(props.subdomain)}/tickets/${props.ticketId}.json`,
      { auth, body: { ticket } },
    );
    return res.data.ticket;
  },
});

/** List tickets, following the `next_page` cursor up to `limit`. */
export const listTickets = defineAction({
  type: LIST_TICKETS_TYPE,
  name: 'List tickets',
  description: 'List Zendesk tickets.',
  auth: zendeskAuth,
  props: {
    subdomain: subdomainProp(),
    limit: number({ label: 'Max results', required: false, defaultValue: 100 }),
  },
  async run({ auth, props, http }): Promise<{ tickets: ZendeskTicket[]; count: number }> {
    const tickets = await paginate<ZendeskTicket>({
      http,
      auth,
      url: `${zendeskBaseUrl(props.subdomain)}/tickets.json`,
      query: { per_page: 100 },
      extractItems: (res) => (res.data as { tickets: ZendeskTicket[] }).tickets,
      nextPage: zendeskNextPage,
      maxItems: props.limit ?? 100,
    });
    return { tickets, count: tickets.length };
  },
});
