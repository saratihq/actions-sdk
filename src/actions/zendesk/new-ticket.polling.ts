import { defineTrigger } from '../../core/trigger';
import type { QueryValue } from '../../core/http/types';
import { subdomainProp, type ZendeskTicket, zendeskAuth, zendeskBaseUrl } from './common';

/** Polling trigger (`zendesk.new_ticket`) — walks the incremental cursor export, emitting only tickets created at/after the moment watching began. */
export const NEW_TICKET_TYPE = 'zendesk.new_ticket';

/** Zendesk requires `start_time` to be more than one minute in the past; seed two minutes back to be safe. */
const START_LOOKBACK_SEC = 120;
/** Per-poll page cap — the persisted cursor resumes the drain on the next poll. */
const MAX_PAGES = 10;

/** A normalised new-ticket event — trimmed to the fields workflows use. */
export interface ZendeskTicketEvent {
  id: number;
  subject: string;
  status: string;
  priority?: string | null;
  requesterId?: number;
  assigneeId?: number | null;
  tags?: string[];
  /** ISO-8601 creation time. */
  createdAt?: string;
}

/** The incremental cursor-export envelope. */
interface ZendeskIncrementalResponse {
  tickets?: ZendeskTicket[];
  after_cursor?: string | null;
  end_of_stream?: boolean;
}

function toEvent(t: ZendeskTicket): ZendeskTicketEvent {
  return {
    id: t.id,
    subject: t.subject ?? '',
    status: t.status ?? '',
    ...(t.priority !== undefined ? { priority: t.priority } : {}),
    ...(typeof t.requester_id === 'number' ? { requesterId: t.requester_id } : {}),
    ...(t.assignee_id !== undefined ? { assigneeId: t.assignee_id } : {}),
    ...(t.tags ? { tags: t.tags } : {}),
    ...(t.created_at ? { createdAt: t.created_at } : {}),
  };
}

/** Parse a Zendesk ISO-8601 timestamp to Unix seconds; NaN → 0 (never filters legitimately). */
function toSeconds(iso?: string): number {
  const ms = Date.parse(iso ?? '');
  return Number.isNaN(ms) ? 0 : Math.floor(ms / 1000);
}

export const newTicket = defineTrigger({
  type: NEW_TICKET_TYPE,
  strategy: 'polling',
  name: 'New ticket',
  description: 'Fires when a ticket is created in Zendesk.',
  auth: zendeskAuth,
  props: {
    subdomain: subdomainProp(),
  },
  sampleData: {
    id: 35436,
    subject: 'Help, my printer is on fire!',
    status: 'open',
    priority: 'high',
    requesterId: 20978392,
    assigneeId: 235323,
    tags: ['enterprise', 'other_tag'],
    createdAt: '2024-01-17T19:55:04Z',
  },
  async poll({ auth, props, http, store }): Promise<ZendeskTicketEvent[]> {
    const url = `${zendeskBaseUrl(props.subdomain)}/incremental/tickets/cursor.json`;
    const cursor = await store.get<string>('cursor');
    let startedAt = await store.get<number>('startedAt');

    let query: Record<string, QueryValue>;
    if (cursor === undefined) {
      // Seed in the past (API rule) but watermark at now, so history isn't backfilled.
      startedAt = Math.floor(Date.now() / 1000);
      await store.set('startedAt', startedAt);
      query = { start_time: startedAt - START_LOOKBACK_SEC };
    } else {
      query = { cursor };
    }

    const collected: ZendeskTicket[] = [];
    let nextCursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const res = await http.get<ZendeskIncrementalResponse>(url, { auth, query });
      collected.push(...(res.data.tickets ?? []));
      const after = res.data.after_cursor ?? undefined;
      if (after !== undefined) nextCursor = after;
      if (res.data.end_of_stream || after === undefined) break;
      query = { cursor: after };
    }

    if (nextCursor !== undefined) await store.set('cursor', nextCursor);
    const started = startedAt ?? 0;
    // Incremental returns created OR updated tickets — keep only genuinely new ones.
    return collected.filter((t) => toSeconds(t.created_at) >= started).map(toEvent);
  },
  dedupeKey: (event): string => String(event.id),
});
