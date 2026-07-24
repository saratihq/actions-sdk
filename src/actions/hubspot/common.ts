import type { ApiKeyScheme, AuthHandle } from '../../core/auth';
import type { HttpClient } from '../../core/http/client';
import type { DropdownOption } from '../../core/props';

/**
 * Shared HubSpot (CRM v3) building blocks: the `/crm/v3` endpoints, Bearer auth,
 * the `{ properties }` object model, and the `{ results, paging }` envelope are
 * HubSpot's public contract. JSON throughout, so writes work.
 */

export const HUBSPOT_API_BASE = 'https://api.hubapi.com';

/**
 * HubSpot authenticates with an OAuth access token or a private-app token, both
 * as a Bearer credential. Declared as an `apiKey` header scheme so BYO paste and
 * managed OAuth run identical action code.
 */
export const hubspotAuth: ApiKeyScheme = {
  type: 'apiKey',
  in: 'header',
  name: 'Authorization',
  prefix: 'Bearer ',
};

/** A HubSpot CRM object (contact/company/deal), trimmed to what workflows read. */
export interface HubspotObject {
  id: string;
  properties: Record<string, string | null>;
  createdAt?: string;
  updatedAt?: string;
  archived?: boolean;
}

/** A HubSpot owner (a CRM user), trimmed to what the owner picker uses. */
export interface HubspotOwner {
  id: string;
  email?: string;
  firstName?: string;
  lastName?: string;
}

/** A HubSpot pipeline (e.g. a deal pipeline) and its ordered stages. */
export interface HubspotPipeline {
  id: string;
  label: string;
  stages?: Array<{ id: string; label: string }>;
}

/** Fetch owners (CRM users) — shared by the list action and the owner picker. */
export async function listHubspotOwners(http: HttpClient, auth: AuthHandle): Promise<HubspotOwner[]> {
  const res = await http.get<{ results: HubspotOwner[] }>(`${HUBSPOT_API_BASE}/crm/v3/owners`, {
    auth,
    query: { limit: 100 },
  });
  return res.data.results;
}

/** Live owner picker — independent of any other prop, so it works under today's loader contract. */
export async function ownerOptions(http: HttpClient, auth: AuthHandle): Promise<DropdownOption<string>[]> {
  const owners = await listHubspotOwners(http, auth);
  return owners.map((owner) => {
    const name = [owner.firstName, owner.lastName].filter(Boolean).join(' ').trim();
    return { label: name || owner.email || owner.id, value: owner.id };
  });
}

/** Fetch the deal pipelines — prop-independent, so it backs the live pipeline picker. */
export async function listDealPipelines(http: HttpClient, auth: AuthHandle): Promise<HubspotPipeline[]> {
  const res = await http.get<{ results: HubspotPipeline[] }>(`${HUBSPOT_API_BASE}/crm/v3/pipelines/deals`, {
    auth,
  });
  return res.data.results;
}

/** Live deal-pipeline picker — independent of any other prop, so it works under today's loader contract. */
export async function pipelineOptions(http: HttpClient, auth: AuthHandle): Promise<DropdownOption<string>[]> {
  const pipelines = await listDealPipelines(http, auth);
  return pipelines.map((pipeline) => ({ label: pipeline.label, value: pipeline.id }));
}
