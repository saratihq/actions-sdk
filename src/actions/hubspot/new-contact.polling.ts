import { defineTrigger } from '../../core/trigger';
import type { JsonValue } from '../../core/http/types';
import { HUBSPOT_API_BASE, type HubspotObject, hubspotAuth } from './common';

/**
 * Fires when a contact is created. Polling, not webhooks: HubSpot's webhooks are app-level, with no
 * public API to register a per-portal hook with a runtime secret. `createdate` filters take epoch-millis.
 */
export const NEW_CONTACT_TYPE = 'hubspot.new_contact';

const SEARCH_URL = `${HUBSPOT_API_BASE}/crm/v3/objects/contacts/search`;
/**
 * Subtracted from the watermark before it becomes the `createdate GT` bound. Must stay far wider than
 * HubSpot's eventually-consistent search lag, or late-indexed contacts are dropped permanently.
 */
const OVERLAP_MS = 60_000;
const PAGE_LIMIT = 100;
/** Per-poll page cap — bounds work; ASC ordering guarantees forward progress across polls on a burst. */
const MAX_PAGES = 10;
/** Contact properties fetched on every poll (HubSpot returns only what you ask for). */
const CONTACT_PROPERTIES = ['email', 'firstname', 'lastname', 'phone', 'company', 'createdate'];

/** A normalised new-contact event — trimmed to the fields workflows use. */
export interface HubspotContactEvent {
  id: string;
  /** ISO-8601 creation time (HubSpot `createdAt`). */
  createdAt: string;
  email?: string;
  firstname?: string;
  lastname?: string;
  /** The full requested property map, for workflows that read other fields. */
  properties: Record<string, string | null>;
}

/** The CRM v3 search envelope (the relevant fields). */
interface HubspotSearchResponse {
  results?: HubspotObject[];
  total?: number;
  paging?: { next?: { after?: string } };
}

function toEvent(o: HubspotObject): HubspotContactEvent {
  const p = o.properties ?? {};
  return {
    id: o.id,
    createdAt: o.createdAt ?? '',
    ...(p.email ? { email: p.email } : {}),
    ...(p.firstname ? { firstname: p.firstname } : {}),
    ...(p.lastname ? { lastname: p.lastname } : {}),
    properties: p,
  };
}

export const newContact = defineTrigger({
  type: NEW_CONTACT_TYPE,
  strategy: 'polling',
  name: 'New contact',
  description: 'Fires when a contact is created in HubSpot.',
  auth: hubspotAuth,
  props: {},
  sampleData: {
    id: '512',
    createdAt: '2024-01-17T19:55:04.281Z',
    email: 'jane@example.com',
    firstname: 'Jane',
    lastname: 'Doe',
    properties: {
      email: 'jane@example.com',
      firstname: 'Jane',
      lastname: 'Doe',
      phone: '+15551234567',
      company: 'Acme',
      createdate: '2024-01-17T19:55:04.281Z',
    },
  },
  async poll({ auth, http, store, lastPolledAt }): Promise<HubspotContactEvent[]> {
    const nowMs = Date.now();
    // First poll self-baselines at "now", so the portal's pre-existing contacts are never backfilled.
    if (lastPolledAt === undefined) {
      await store.set('cursor', nowMs);
      return [];
    }

    const stored = await store.get<number>('cursor');
    const baseline = stored ?? nowMs;
    const sinceMs = Math.max(0, baseline - OVERLAP_MS);
    let maxCreated = baseline;
    let after: string | undefined;
    const collected: HubspotObject[] = [];

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const body: Record<string, JsonValue> = {
        filterGroups: [{ filters: [{ propertyName: 'createdate', operator: 'GT', value: String(sinceMs) }] }],
        sorts: [{ propertyName: 'createdate', direction: 'ASCENDING' }],
        properties: CONTACT_PROPERTIES,
        limit: PAGE_LIMIT,
      };
      if (after !== undefined) body.after = after;
      const res = await http.post<HubspotSearchResponse>(SEARCH_URL, { auth, body });
      const results = res.data.results ?? [];
      collected.push(...results);
      for (const r of results) {
        const ms = Date.parse(r.createdAt ?? '');
        if (!Number.isNaN(ms) && ms > maxCreated) maxCreated = ms;
      }
      const next = res.data.paging?.next?.after;
      if (next === undefined || results.length === 0) break;
      after = next;
    }

    await store.set('cursor', maxCreated);
    return collected.map(toEvent);
  },
  dedupeKey: (event): string => event.id,
});
