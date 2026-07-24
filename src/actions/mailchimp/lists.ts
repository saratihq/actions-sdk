import { defineAction } from '../../core/action';
import { number, shortText } from '../../core/props';
import {
  mailchimpAuth,
  mailchimpBaseUrl,
  type MailchimpCampaign,
  type MailchimpList,
  serverPrefixProp,
} from './common';

/** Public types — stable public catalog ids. */
export const LIST_AUDIENCES_TYPE = 'mailchimp.list_audiences';
export const GET_LIST_TYPE = 'mailchimp.get_list';
export const LIST_CAMPAIGNS_TYPE = 'mailchimp.list_campaigns';

/**
 * List audiences (lists). Read-only and the benign live-smoke action for
 * Mailchimp. One page (accounts have few audiences); `count` caps it.
 */
export const listAudiences = defineAction({
  type: LIST_AUDIENCES_TYPE,
  name: 'List audiences',
  description: 'List Mailchimp audiences (lists).',
  auth: mailchimpAuth,
  props: {
    serverPrefix: serverPrefixProp(),
    count: number({ label: 'Max results', required: false, defaultValue: 100 }),
  },
  async run({ auth, props, http }): Promise<{ lists: MailchimpList[]; count: number }> {
    const res = await http.get<{ lists: MailchimpList[]; total_items: number }>(
      `${mailchimpBaseUrl(props.serverPrefix)}/lists`,
      { auth, query: { count: props.count ?? 100 } },
    );
    return { lists: res.data.lists, count: res.data.lists.length };
  },
});

/** Retrieve a single audience by id. Read-only. */
export const getList = defineAction({
  type: GET_LIST_TYPE,
  name: 'Get audience',
  description: 'Retrieve a Mailchimp audience (list) by id.',
  auth: mailchimpAuth,
  props: {
    serverPrefix: serverPrefixProp(),
    listId: shortText<true>({ label: 'Audience id', required: true }),
  },
  async run({ auth, props, http }): Promise<MailchimpList> {
    const res = await http.get<MailchimpList>(
      `${mailchimpBaseUrl(props.serverPrefix)}/lists/${encodeURIComponent(props.listId)}`,
      { auth },
    );
    return res.data;
  },
});

/** List campaigns. Read-only. */
export const listCampaigns = defineAction({
  type: LIST_CAMPAIGNS_TYPE,
  name: 'List campaigns',
  description: 'List Mailchimp campaigns.',
  auth: mailchimpAuth,
  props: {
    serverPrefix: serverPrefixProp(),
    count: number({ label: 'Max results', required: false, defaultValue: 50 }),
  },
  async run({ auth, props, http }): Promise<{ campaigns: MailchimpCampaign[]; count: number }> {
    const res = await http.get<{ campaigns: MailchimpCampaign[]; total_items: number }>(
      `${mailchimpBaseUrl(props.serverPrefix)}/campaigns`,
      { auth, query: { count: props.count ?? 50 } },
    );
    return { campaigns: res.data.campaigns, count: res.data.campaigns.length };
  },
});
