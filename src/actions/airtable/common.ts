import type { ApiKeyScheme, AuthHandle } from '../../core/auth';
import type { HttpClient } from '../../core/http/client';
import { cursorInBody, paginate } from '../../core/http/pagination';
import type { JsonValue } from '../../core/http/types';
import { checkbox, type DropdownOption } from '../../core/props';

/**
 * Shared Airtable building blocks: Airtable's `/v0` REST endpoints, the Bearer
 * PAT auth, the `{ records, offset }` / `{ bases, offset }` envelopes, and the
 * `offset` cursor are Airtable's public API contract. Airtable takes and returns
 * JSON, so writes work directly.
 */

export const AIRTABLE_API_BASE = 'https://api.airtable.com/v0';

/**
 * Airtable authenticates with a personal access token as a Bearer credential;
 * managed OAuth attaches its token the same way. Declared as an `apiKey` header
 * scheme so both transports run identical action code.
 */
export const airtableAuth: ApiKeyScheme = {
  type: 'apiKey',
  in: 'header',
  name: 'Authorization',
  prefix: 'Bearer ',
};

/** An Airtable base (a "database"), trimmed to what the base picker uses. */
export interface AirtableBase {
  id: string;
  name: string;
  permissionLevel?: string;
}

/** An Airtable record. `fields` is open — the shape is the table's, not the SDK's. */
export interface AirtableRecord {
  id: string;
  createdTime: string;
  fields: Record<string, JsonValue>;
}

interface BasesEnvelope {
  bases?: AirtableBase[];
  offset?: string;
}

/**
 * List every base the token can see, following Airtable's `offset` cursor to
 * completion. Shared by the `list_bases` action and the base picker — the offset
 * lives in the body and writes back onto the same URL's query, so the SDK's
 * `cursorInBody` helper covers it.
 */
export function listAirtableBases(http: HttpClient, auth: AuthHandle): Promise<AirtableBase[]> {
  return paginate<AirtableBase>({
    http,
    auth,
    url: `${AIRTABLE_API_BASE}/meta/bases`,
    extractItems: (res) => (res.data as BasesEnvelope).bases ?? [],
    nextPage: cursorInBody({ cursorPath: ['offset'], cursorParam: 'offset' }),
    maxItems: 1000,
  });
}

/** Live base picker — independent of any other prop, so it works under today's loader contract. */
export async function baseOptions(http: HttpClient, auth: AuthHandle): Promise<DropdownOption<string>[]> {
  const bases = await listAirtableBases(http, auth);
  return bases.map((base) => ({ label: base.name, value: base.id }));
}

/** The shared `typecast` toggle — lets Airtable coerce string inputs to the column's type. */
export function checkboxTypecast() {
  return checkbox({
    label: 'Typecast',
    description: 'Coerce string values to the column type (parse dates, create select options).',
    required: false,
    defaultValue: true,
  });
}
