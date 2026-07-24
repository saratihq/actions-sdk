import { defineAction } from '../../core/action';
import { type HubspotOwner, hubspotAuth, listHubspotOwners } from './common';

/** Public type — a stable public catalog id. */
export const LIST_OWNERS_TYPE = 'hubspot.list_owners';

/**
 * List owners (CRM users). Read-only and the benign live-smoke action for
 * HubSpot — it also underpins the owner picker on `create_contact`.
 */
export const listOwners = defineAction({
  type: LIST_OWNERS_TYPE,
  name: 'List owners',
  description: 'List the owners (users) in the HubSpot account.',
  auth: hubspotAuth,
  props: {},
  async run({ auth, http }): Promise<{ owners: HubspotOwner[]; count: number }> {
    const owners = await listHubspotOwners(http, auth);
    return { owners, count: owners.length };
  },
});
