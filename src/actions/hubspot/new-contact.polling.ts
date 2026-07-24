import { defineTrigger } from '../../core/trigger';
import type { JsonValue } from '../../core/http/types';
import { HUBSPOT_API_BASE, type HubspotObject, hubspotAuth } from './common';

/**
 * Polling trigger (`hubspot.new_contact`) — fires when a contact is created.
 *
 * Why polling, not a registered webhook: HubSpot's webhooks are **app-level**: a
 * single target URL configured on the developer app, with subscriptions
 * (`contact.creation`, …) that fan in every install to that one URL and are
 * signed with the app's client secret. There is no public API to register a
 * per-connection (per-portal) webhook with a runtime-provided secret, so the
 * correct-by-construction choice is to poll the CRM v3 search endpoint, filtering
 * on `createdate` and deduping by contact id.
 *
 * Search shape (POST `/crm/v3/objects/contacts/search`, `createdate GT` filter in
 * epoch-millis, `sorts` ASCENDING, `paging.next.after` cursor) is HubSpot's
 * public contract — see
 * https://developers.hubspot.com/docs/guides/api/crm/search . `createdate` filters
 * take an epoch-milliseconds string; `results[].createdAt` comes back ISO-8601.
 *
 * First-poll baseline: on an EMPTY watermark the poll persists the baseline and
 * returns `[]`, so activating the trigger never backfills the portal's existing
 * contacts — only contacts created AFTER activation fire.
 */
export const NEW_CONTACT_TYPE = 'hubspot.new_contact';

const SEARCH_URL = `${HUBSPOT_API_BASE}/crm/v3/objects/contacts/search`;
/**
 * Re-scan overlap (60s) subtracted from the watermark before it becomes the
 * `createdate GT` bound. HubSpot's Search index is eventually consistent — a
 * newly-created contact can take several seconds to become searchable and results
 * can surface out of `createdate` order — so a boundary of `watermark - 2s` would
 * permanently drop contacts indexed late. A window this much wider than the index
 * lag guarantees a late-indexed contact is re-scanned on a later poll; the SDK's
 * id-dedupe keeps the wider re-scan exactly-once.
 * Docs: https://developers.hubspot.com/docs/guides/api/crm/search
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
    // First poll (empty watermark): self-baseline. Persist the cursor at "now"
    // and emit nothing, so the portal's pre-existing contacts are never
    // backfilled as new. Only contacts created after this fire on later polls.
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
