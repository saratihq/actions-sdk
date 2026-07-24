import { defineAction } from '../../core/action';
import { cursorInBody, paginate } from '../../core/http/pagination';
import type { JsonValue } from '../../core/http/types';
import { dropdown, json, number, shortText } from '../../core/props';
import { HUBSPOT_API_BASE, type HubspotObject, hubspotAuth, ownerOptions } from './common';

/** Public types — stable public catalog ids. */
export const CREATE_CONTACT_TYPE = 'hubspot.create_contact';
export const GET_CONTACT_TYPE = 'hubspot.get_contact';
export const UPDATE_CONTACT_TYPE = 'hubspot.update_contact';
export const LIST_CONTACTS_TYPE = 'hubspot.list_contacts';
export const SEARCH_CONTACTS_TYPE = 'hubspot.search_contacts';

const CONTACTS_URL = `${HUBSPOT_API_BASE}/crm/v3/objects/contacts`;

/** Merge the discrete common props + owner + extra properties into HubSpot's `properties` map. */
function buildProperties(input: {
  email?: string;
  firstname?: string;
  lastname?: string;
  phone?: string;
  company?: string;
  ownerId?: string;
  additional?: JsonValue;
}): Record<string, JsonValue> {
  const properties: Record<string, JsonValue> = {};
  if (input.email !== undefined) properties.email = input.email;
  if (input.firstname !== undefined) properties.firstname = input.firstname;
  if (input.lastname !== undefined) properties.lastname = input.lastname;
  if (input.phone !== undefined) properties.phone = input.phone;
  if (input.company !== undefined) properties.company = input.company;
  if (input.ownerId !== undefined) properties.hubspot_owner_id = input.ownerId;
  if (input.additional && typeof input.additional === 'object' && !Array.isArray(input.additional)) {
    Object.assign(properties, input.additional);
  }
  return properties;
}

/** Create a contact. The **owner picker is live** (owners are prop-independent). */
export const createContact = defineAction({
  type: CREATE_CONTACT_TYPE,
  name: 'Create contact',
  description: 'Create a HubSpot contact.',
  auth: hubspotAuth,
  props: {
    email: shortText({ label: 'Email', required: false }),
    firstname: shortText({ label: 'First name', required: false }),
    lastname: shortText({ label: 'Last name', required: false }),
    phone: shortText({ label: 'Phone', required: false }),
    company: shortText({ label: 'Company', required: false }),
    ownerId: dropdown<string, false>({
      label: 'Owner',
      description: 'Assign a HubSpot owner — loaded live.',
      required: false,
      options: ({ auth, http }) => ownerOptions(http, auth),
    }),
    additionalProperties: json({
      label: 'Additional properties',
      description: 'Other contact properties.',
      required: false,
    }),
  },
  async run({ auth, props, http }): Promise<HubspotObject> {
    const properties = buildProperties({
      ...(props.email !== undefined ? { email: props.email } : {}),
      ...(props.firstname !== undefined ? { firstname: props.firstname } : {}),
      ...(props.lastname !== undefined ? { lastname: props.lastname } : {}),
      ...(props.phone !== undefined ? { phone: props.phone } : {}),
      ...(props.company !== undefined ? { company: props.company } : {}),
      ...(props.ownerId !== undefined ? { ownerId: props.ownerId } : {}),
      ...(props.additionalProperties !== undefined ? { additional: props.additionalProperties } : {}),
    });
    const res = await http.post<HubspotObject>(CONTACTS_URL, { auth, body: { properties } });
    return res.data;
  },
});

/** Retrieve a contact by id, optionally naming which properties to return. */
export const getContact = defineAction({
  type: GET_CONTACT_TYPE,
  name: 'Get contact',
  description: 'Retrieve a HubSpot contact by id.',
  auth: hubspotAuth,
  props: {
    contactId: shortText<true>({ label: 'Contact id', required: true }),
    properties: shortText({
      label: 'Properties',
      description: 'Comma-separated property names to return.',
      required: false,
    }),
  },
  async run({ auth, props, http }): Promise<HubspotObject> {
    const res = await http.get<HubspotObject>(`${CONTACTS_URL}/${encodeURIComponent(props.contactId)}`, {
      auth,
      query: { properties: props.properties },
    });
    return res.data;
  },
});

/** Update a contact's properties. */
export const updateContact = defineAction({
  type: UPDATE_CONTACT_TYPE,
  name: 'Update contact',
  description: 'Update a HubSpot contact.',
  auth: hubspotAuth,
  props: {
    contactId: shortText<true>({ label: 'Contact id', required: true }),
    properties: json<true>({
      label: 'Properties',
      description: 'A { property: value } object.',
      required: true,
    }),
  },
  async run({ auth, props, http }): Promise<HubspotObject> {
    const res = await http.patch<HubspotObject>(`${CONTACTS_URL}/${encodeURIComponent(props.contactId)}`, {
      auth,
      body: { properties: props.properties },
    });
    return res.data;
  },
});

/** List contacts, following the `paging.next.after` cursor up to `limit`. */
export const listContacts = defineAction({
  type: LIST_CONTACTS_TYPE,
  name: 'List contacts',
  description: 'List HubSpot contacts.',
  auth: hubspotAuth,
  props: {
    limit: number({ label: 'Max results', required: false, defaultValue: 100 }),
    properties: shortText({
      label: 'Properties',
      description: 'Comma-separated property names to return.',
      required: false,
    }),
  },
  async run({ auth, props, http }): Promise<{ contacts: HubspotObject[]; count: number }> {
    const contacts = await paginate<HubspotObject>({
      http,
      auth,
      url: CONTACTS_URL,
      query: { limit: 100, properties: props.properties },
      extractItems: (res) => (res.data as { results: HubspotObject[] }).results,
      nextPage: cursorInBody({ cursorPath: ['paging', 'next', 'after'], cursorParam: 'after' }),
      maxItems: props.limit ?? 100,
    });
    return { contacts, count: contacts.length };
  },
});

/** The CRM v3 search envelope: matched objects, the overall `total`, and an `after` cursor. */
interface HubspotSearchResponse {
  results: HubspotObject[];
  total: number;
  paging?: { next?: { after?: string } };
}

/**
 * Search contacts by a free-text `query`, or by a single property filter
 * (`propertyName` OPERATOR `value`), following the CRM v3 search `paging.next.after`
 * cursor up to `limit`. Search pages inside the POST body (the cursor is `after`
 * in, `paging.next.after` out), so this is a small hand-rolled POST loop rather
 * than the GET-oriented `paginate` helper.
 */
export const searchContacts = defineAction({
  type: SEARCH_CONTACTS_TYPE,
  name: 'Search contacts',
  description: 'Search HubSpot contacts.',
  auth: hubspotAuth,
  props: {
    query: shortText({
      label: 'Query',
      description: 'Free-text search across searchable properties.',
      required: false,
    }),
    propertyName: shortText({
      label: 'Property',
      description: 'Property to filter on (with value).',
      required: false,
    }),
    operator: dropdown<string, false>({
      label: 'Operator',
      required: false,
      defaultValue: 'EQ',
      options: [
        { label: 'Equals', value: 'EQ' },
        { label: 'Not equals', value: 'NEQ' },
        { label: 'Contains token', value: 'CONTAINS_TOKEN' },
        { label: 'Greater than', value: 'GT' },
        { label: 'Less than', value: 'LT' },
      ],
    }),
    value: shortText({ label: 'Value', required: false }),
    limit: number({ label: 'Max results', required: false, defaultValue: 20 }),
  },
  async run({ auth, props, http }): Promise<{ contacts: HubspotObject[]; count: number; total: number }> {
    const base: Record<string, JsonValue> = {};
    if (props.query !== undefined) base.query = props.query;
    if (props.propertyName !== undefined && props.value !== undefined) {
      base.filterGroups = [
        {
          filters: [
            { propertyName: props.propertyName, operator: props.operator ?? 'EQ', value: props.value },
          ],
        },
      ];
    }
    const max = props.limit ?? 20;
    const contacts: HubspotObject[] = [];
    let after: string | undefined;
    let total = 0;
    for (let page = 0; page < 25 && contacts.length < max; page += 1) {
      const body: Record<string, JsonValue> = { ...base, limit: Math.min(100, max - contacts.length) };
      if (after !== undefined) body.after = after;
      const res = await http.post<HubspotSearchResponse>(`${CONTACTS_URL}/search`, { auth, body });
      total = res.data.total ?? total;
      contacts.push(...res.data.results);
      const next = res.data.paging?.next?.after;
      if (next === undefined) break;
      after = next;
    }
    return { contacts: contacts.slice(0, max), count: Math.min(contacts.length, max), total };
  },
});
