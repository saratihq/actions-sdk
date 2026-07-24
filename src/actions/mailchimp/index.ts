export {
  type MailchimpCampaign,
  type MailchimpList,
  type MailchimpMember,
  mailchimpAuth,
  mailchimpBaseUrl,
  subscriberHash,
} from './common';
export {
  GET_LIST_TYPE,
  getList,
  LIST_AUDIENCES_TYPE,
  LIST_CAMPAIGNS_TYPE,
  listAudiences,
  listCampaigns,
} from './lists';
export {
  ADD_MEMBER_TYPE,
  addMember,
  GET_MEMBER_TYPE,
  getMember,
  UPDATE_MEMBER_TYPE,
  updateMember,
} from './members';

export { NEW_SUBSCRIBER_TYPE, newSubscriber, type MailchimpSubscriberEvent } from './new-subscriber.polling';

import { getList, listAudiences, listCampaigns } from './lists';
import { addMember, getMember, updateMember } from './members';

/** Every Mailchimp action, for catalog builds and registration. */
export const mailchimpActions = [
  listAudiences,
  getList,
  listCampaigns,
  addMember,
  getMember,
  updateMember,
] as const;
