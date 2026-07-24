import { defineAction } from '../../core/action';
import type { JsonValue } from '../../core/http/types';
import { dropdown, json, shortText } from '../../core/props';
import {
  mailchimpAuth,
  mailchimpBaseUrl,
  type MailchimpMember,
  serverPrefixProp,
  subscriberHash,
} from './common';

/** Public types — stable public catalog ids. */
export const ADD_MEMBER_TYPE = 'mailchimp.add_member';
export const GET_MEMBER_TYPE = 'mailchimp.get_member';
export const UPDATE_MEMBER_TYPE = 'mailchimp.update_member';

const STATUS_OPTIONS = [
  { label: 'Subscribed', value: 'subscribed' },
  { label: 'Pending (double opt-in)', value: 'pending' },
  { label: 'Unsubscribed', value: 'unsubscribed' },
  { label: 'Cleaned', value: 'cleaned' },
];

/** Add a member to an audience. `mergeFields` carries FNAME/LNAME/etc. */
export const addMember = defineAction({
  type: ADD_MEMBER_TYPE,
  name: 'Add member',
  description: 'Add a member to a Mailchimp audience.',
  auth: mailchimpAuth,
  props: {
    serverPrefix: serverPrefixProp(),
    listId: shortText<true>({ label: 'Audience id', required: true }),
    email: shortText<true>({ label: 'Email', required: true }),
    status: dropdown<string, false>({
      label: 'Status',
      required: false,
      defaultValue: 'subscribed',
      options: STATUS_OPTIONS,
    }),
    mergeFields: json({ label: 'Merge fields', description: 'e.g. { "FNAME": "Ada" }.', required: false }),
  },
  async run({ auth, props, http }): Promise<MailchimpMember> {
    const body: Record<string, JsonValue> = {
      email_address: props.email,
      status: props.status ?? 'subscribed',
    };
    if (props.mergeFields !== undefined) body.merge_fields = props.mergeFields;
    const res = await http.post<MailchimpMember>(
      `${mailchimpBaseUrl(props.serverPrefix)}/lists/${encodeURIComponent(props.listId)}/members`,
      { auth, body },
    );
    return res.data;
  },
});

/** Retrieve a member by email (addressed via the MD5 subscriber hash). Read-only. */
export const getMember = defineAction({
  type: GET_MEMBER_TYPE,
  name: 'Get member',
  description: 'Retrieve a Mailchimp audience member by email.',
  auth: mailchimpAuth,
  props: {
    serverPrefix: serverPrefixProp(),
    listId: shortText<true>({ label: 'Audience id', required: true }),
    email: shortText<true>({ label: 'Email', required: true }),
  },
  async run({ auth, props, http }): Promise<MailchimpMember> {
    const hash = subscriberHash(props.email);
    const res = await http.get<MailchimpMember>(
      `${mailchimpBaseUrl(props.serverPrefix)}/lists/${encodeURIComponent(props.listId)}/members/${hash}`,
      { auth },
    );
    return res.data;
  },
});

/** Update a member's status and/or merge fields. */
export const updateMember = defineAction({
  type: UPDATE_MEMBER_TYPE,
  name: 'Update member',
  description: 'Update a Mailchimp audience member.',
  auth: mailchimpAuth,
  props: {
    serverPrefix: serverPrefixProp(),
    listId: shortText<true>({ label: 'Audience id', required: true }),
    email: shortText<true>({ label: 'Email', required: true }),
    status: dropdown<string, false>({ label: 'Status', required: false, options: STATUS_OPTIONS }),
    mergeFields: json({ label: 'Merge fields', required: false }),
  },
  async run({ auth, props, http }): Promise<MailchimpMember> {
    const hash = subscriberHash(props.email);
    const body: Record<string, JsonValue> = {};
    if (props.status !== undefined) body.status = props.status;
    if (props.mergeFields !== undefined) body.merge_fields = props.mergeFields;
    const res = await http.patch<MailchimpMember>(
      `${mailchimpBaseUrl(props.serverPrefix)}/lists/${encodeURIComponent(props.listId)}/members/${hash}`,
      { auth, body },
    );
    return res.data;
  },
});
