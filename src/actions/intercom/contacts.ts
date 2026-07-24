import { defineAction } from '../../core/action';
import { cursorInBody, paginate } from '../../core/http/pagination';
import type { JsonValue } from '../../core/http/types';
import { dropdown, json, number, shortText } from '../../core/props';
import {
  adminOptions,
  INTERCOM_API_BASE,
  INTERCOM_HEADERS,
  type IntercomContact,
  type IntercomList,
  intercomAuth,
} from './common';

/** Public types — stable public catalog ids. */
export const LIST_CONTACTS_TYPE = 'intercom.list_contacts';
export const GET_CONTACT_TYPE = 'intercom.get_contact';
export const CREATE_CONTACT_TYPE = 'intercom.create_contact';
export const SEARCH_CONTACTS_TYPE = 'intercom.search_contacts';

/** List contacts, following Intercom's `pages.next.starting_after` cursor up to `limit`. */
export const listContacts = defineAction({
  type: LIST_CONTACTS_TYPE,
  name: 'List contacts',
  description: 'List Intercom contacts.',
  auth: intercomAuth,
  props: {
    limit: number({ label: 'Max results', required: false, defaultValue: 50 }),
  },
  async run({ auth, props, http }): Promise<{ contacts: IntercomContact[]; count: number }> {
    const contacts = await paginate<IntercomContact>({
      http,
      auth,
      url: `${INTERCOM_API_BASE}/contacts`,
      query: { per_page: 50 },
      headers: INTERCOM_HEADERS,
      extractItems: (res) => (res.data as IntercomList<IntercomContact>).data,
      nextPage: cursorInBody({
        cursorPath: ['pages', 'next', 'starting_after'],
        cursorParam: 'starting_after',
      }),
      maxItems: props.limit ?? 50,
    });
    return { contacts, count: contacts.length };
  },
});

/** Retrieve a single contact by id. Read-only. */
export const getContact = defineAction({
  type: GET_CONTACT_TYPE,
  name: 'Get contact',
  description: 'Retrieve an Intercom contact by id.',
  auth: intercomAuth,
  props: {
    contactId: shortText<true>({ label: 'Contact id', required: true }),
  },
  async run({ auth, props, http }): Promise<IntercomContact> {
    const res = await http.get<IntercomContact>(
      `${INTERCOM_API_BASE}/contacts/${encodeURIComponent(props.contactId)}`,
      { auth, headers: INTERCOM_HEADERS },
    );
    return res.data;
  },
});

/**
 * Create a contact (a `user` or a `lead`). The **owner picker is live** (admins
 * are a small, prop-independent set). `customAttributes` is the escape hatch for
 * app-defined fields.
 */
export const createContact = defineAction({
  type: CREATE_CONTACT_TYPE,
  name: 'Create contact',
  description: 'Create an Intercom contact.',
  auth: intercomAuth,
  props: {
    role: dropdown<string, false>({
      label: 'Role',
      required: false,
      defaultValue: 'user',
      options: [
        { label: 'User', value: 'user' },
        { label: 'Lead', value: 'lead' },
      ],
    }),
    email: shortText({ label: 'Email', required: false }),
    name: shortText({ label: 'Name', required: false }),
    phone: shortText({ label: 'Phone', required: false }),
    externalId: shortText({
      label: 'External id',
      description: 'Your own user id for this contact.',
      required: false,
    }),
    ownerId: dropdown<string, false>({
      label: 'Owner',
      description: 'Assign an admin as owner — loaded live.',
      required: false,
      options: ({ auth, http }) => adminOptions(http, auth),
    }),
    customAttributes: json({
      label: 'Custom attributes',
      description: 'App-defined fields.',
      required: false,
    }),
  },
  async run({ auth, props, http }): Promise<IntercomContact> {
    const body: Record<string, JsonValue> = { role: props.role ?? 'user' };
    if (props.email !== undefined) body.email = props.email;
    if (props.name !== undefined) body.name = props.name;
    if (props.phone !== undefined) body.phone = props.phone;
    if (props.externalId !== undefined) body.external_id = props.externalId;
    if (props.ownerId !== undefined) body.owner_id = props.ownerId;
    if (props.customAttributes !== undefined) body.custom_attributes = props.customAttributes;
    const res = await http.post<IntercomContact>(`${INTERCOM_API_BASE}/contacts`, {
      auth,
      headers: INTERCOM_HEADERS,
      body,
    });
    return res.data;
  },
});

/**
 * Search contacts by a single field/operator/value (Intercom's search DSL). For
 * a complex multi-clause query, pass a raw `query` object instead.
 */
export const searchContacts = defineAction({
  type: SEARCH_CONTACTS_TYPE,
  name: 'Search contacts',
  description: 'Search Intercom contacts by a field.',
  auth: intercomAuth,
  props: {
    field: dropdown<string, false>({
      label: 'Field',
      required: false,
      defaultValue: 'email',
      options: [
        { label: 'Email', value: 'email' },
        { label: 'Name', value: 'name' },
        { label: 'External id', value: 'external_id' },
        { label: 'Phone', value: 'phone' },
      ],
    }),
    operator: dropdown<string, false>({
      label: 'Operator',
      required: false,
      defaultValue: '=',
      options: [
        { label: 'Equals', value: '=' },
        { label: 'Contains', value: '~' },
      ],
    }),
    value: shortText({ label: 'Value', required: false }),
    query: json({
      label: 'Raw query',
      description: 'A full Intercom search `query` object (overrides the field inputs).',
      required: false,
    }),
  },
  async run({ auth, props, http }): Promise<{ contacts: IntercomContact[]; count: number }> {
    const query: JsonValue =
      props.query !== undefined
        ? props.query
        : { field: props.field ?? 'email', operator: props.operator ?? '=', value: props.value ?? '' };
    const res = await http.post<IntercomList<IntercomContact>>(`${INTERCOM_API_BASE}/contacts/search`, {
      auth,
      headers: INTERCOM_HEADERS,
      body: { query },
    });
    return { contacts: res.data.data, count: res.data.data.length };
  },
});
