import { defineAction } from '../../core/action';
import { paginate } from '../../core/http/pagination';
import { number, shortText } from '../../core/props';
import { subdomainProp, type ZendeskUser, zendeskAuth, zendeskBaseUrl, zendeskNextPage } from './common';

/** Public types — stable public catalog ids. */
export const SEARCH_TYPE = 'zendesk.search';
export const LIST_USERS_TYPE = 'zendesk.list_users';

/**
 * Run a Zendesk search (the unified search API), e.g.
 * `type:ticket status:open` or `requester:jane@acme.com`. Returns one page.
 */
export const search = defineAction({
  type: SEARCH_TYPE,
  name: 'Search',
  description: 'Search across Zendesk (tickets, users, organizations).',
  auth: zendeskAuth,
  props: {
    subdomain: subdomainProp(),
    query: shortText<true>({
      label: 'Query',
      description: 'Zendesk search syntax, e.g. type:ticket status:open.',
      required: true,
    }),
  },
  async run({ auth, props, http }): Promise<{ results: Array<Record<string, unknown>>; count: number }> {
    const res = await http.get<{ results: Array<Record<string, unknown>>; count: number }>(
      `${zendeskBaseUrl(props.subdomain)}/search.json`,
      { auth, query: { query: props.query } },
    );
    return { results: res.data.results, count: res.data.count };
  },
});

/** List users (agents and end-users), following the cursor up to `limit`. */
export const listUsers = defineAction({
  type: LIST_USERS_TYPE,
  name: 'List users',
  description: 'List Zendesk users.',
  auth: zendeskAuth,
  props: {
    subdomain: subdomainProp(),
    limit: number({ label: 'Max results', required: false, defaultValue: 100 }),
  },
  async run({ auth, props, http }): Promise<{ users: ZendeskUser[]; count: number }> {
    const users = await paginate<ZendeskUser>({
      http,
      auth,
      url: `${zendeskBaseUrl(props.subdomain)}/users.json`,
      query: { per_page: 100 },
      extractItems: (res) => (res.data as { users: ZendeskUser[] }).users,
      nextPage: zendeskNextPage,
      maxItems: props.limit ?? 100,
    });
    return { users, count: users.length };
  },
});
