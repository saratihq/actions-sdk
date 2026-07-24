import { defineAction } from '../../core/action';
import type { JsonValue } from '../../core/http/types';
import { dropdown, json, shortText } from '../../core/props';
import { HUBSPOT_API_BASE, type HubspotObject, hubspotAuth, ownerOptions, pipelineOptions } from './common';

/**
 * Public type — a stable public catalog id. Action namespaces use underscores
 * (`create_deal`); hyphens are invalid.
 */
export const CREATE_DEAL_TYPE = 'hubspot.create_deal';

const DEALS_URL = `${HUBSPOT_API_BASE}/crm/v3/objects/deals`;

/**
 * Create a deal. The **pipeline picker is live** (deal pipelines are
 * prop-independent) and so is the owner picker; `dealstage` is a stage id within
 * the chosen pipeline, so it stays a text input until the loader contract can
 * read the selected pipeline.
 */
export const createDeal = defineAction({
  type: CREATE_DEAL_TYPE,
  name: 'Create deal',
  description: 'Create a HubSpot deal.',
  auth: hubspotAuth,
  props: {
    dealname: shortText<true>({ label: 'Deal name', required: true }),
    pipeline: dropdown<string, false>({
      label: 'Pipeline',
      description: 'The deal pipeline — loaded live.',
      required: false,
      options: ({ auth, http }) => pipelineOptions(http, auth),
    }),
    dealstage: shortText({
      label: 'Deal stage',
      description: 'Stage id within the chosen pipeline.',
      required: false,
    }),
    amount: shortText({ label: 'Amount', required: false }),
    closeDate: shortText({
      label: 'Close date',
      description: 'ISO-8601 date-time or epoch milliseconds.',
      required: false,
    }),
    ownerId: dropdown<string, false>({
      label: 'Owner',
      description: 'Assign a HubSpot owner — loaded live.',
      required: false,
      options: ({ auth, http }) => ownerOptions(http, auth),
    }),
    additionalProperties: json({
      label: 'Additional properties',
      description: 'Other deal properties.',
      required: false,
    }),
  },
  async run({ auth, props, http }): Promise<HubspotObject> {
    const properties: Record<string, JsonValue> = { dealname: props.dealname };
    if (props.pipeline !== undefined) properties.pipeline = props.pipeline;
    if (props.dealstage !== undefined) properties.dealstage = props.dealstage;
    if (props.amount !== undefined) properties.amount = props.amount;
    if (props.closeDate !== undefined) properties.closedate = props.closeDate;
    if (props.ownerId !== undefined) properties.hubspot_owner_id = props.ownerId;
    if (
      props.additionalProperties &&
      typeof props.additionalProperties === 'object' &&
      !Array.isArray(props.additionalProperties)
    ) {
      Object.assign(properties, props.additionalProperties);
    }
    const res = await http.post<HubspotObject>(DEALS_URL, { auth, body: { properties } });
    return res.data;
  },
});
