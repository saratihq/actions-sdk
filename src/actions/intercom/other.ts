import { defineAction } from '../../core/action';
import { cursorInBody, paginate } from '../../core/http/pagination';
import { number } from '../../core/props';
import {
  INTERCOM_API_BASE,
  INTERCOM_HEADERS,
  type IntercomAdmin,
  type IntercomList,
  intercomAuth,
  listIntercomAdmins,
} from './common';

/** Public types — stable public catalog ids. */
export const LIST_CONVERSATIONS_TYPE = 'intercom.list_conversations';
export const LIST_ADMINS_TYPE = 'intercom.list_admins';

/** A conversation, trimmed to the fields workflows read. */
export interface IntercomConversation {
  id: string;
  state?: string;
  created_at?: number;
  updated_at?: number;
}

/** List conversations, following the cursor up to `limit`. */
export const listConversations = defineAction({
  type: LIST_CONVERSATIONS_TYPE,
  name: 'List conversations',
  description: 'List Intercom conversations.',
  auth: intercomAuth,
  props: {
    limit: number({ label: 'Max results', required: false, defaultValue: 50 }),
  },
  async run({ auth, props, http }): Promise<{ conversations: IntercomConversation[]; count: number }> {
    const conversations = await paginate<IntercomConversation>({
      http,
      auth,
      url: `${INTERCOM_API_BASE}/conversations`,
      query: { per_page: 50 },
      headers: INTERCOM_HEADERS,
      extractItems: (res) => (res.data as IntercomList<IntercomConversation>).data,
      nextPage: cursorInBody({
        cursorPath: ['pages', 'next', 'starting_after'],
        cursorParam: 'starting_after',
      }),
      maxItems: props.limit ?? 50,
    });
    return { conversations, count: conversations.length };
  },
});

/**
 * List admins (teammates). Read-only and the benign live-smoke action for
 * Intercom — it also underpins the owner picker on `create_contact`.
 */
export const listAdmins = defineAction({
  type: LIST_ADMINS_TYPE,
  name: 'List admins',
  description: 'List the admins (teammates) in the Intercom workspace.',
  auth: intercomAuth,
  props: {},
  async run({ auth, http }): Promise<{ admins: IntercomAdmin[]; count: number }> {
    const admins = await listIntercomAdmins(http, auth);
    return { admins, count: admins.length };
  },
});
