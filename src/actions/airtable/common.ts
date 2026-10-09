import type { ApiKeyScheme, AuthHandle } from '../../core/auth';
import type { HttpClient } from '../../core/http/client';
import { cursorInBody, paginate } from '../../core/http/pagination';
import type { JsonValue } from '../../core/http/types';
import { checkbox, type DropdownOption } from '../../core/props';

/** Shared Airtable building blocks: `/v0` endpoints, Bearer PAT auth, and the `offset` cursor envelopes. */

export const AIRTABLE_API_BASE = 'https://api.airtable.com/v0';

/** PAT or managed-OAuth token, both as a Bearer header — one `apiKey` scheme so both transports share code. */
export const airtableAuth: ApiKeyScheme = {
  type: 'apiKey',
  origins: ['https://api.airtable.com'],
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

/** An Airtable record; `fields` is open — the shape is the table's, not the SDK's. */
export interface AirtableRecord {
  id: string;
  createdTime: string;
  fields: Record<string, JsonValue>;
}

interface BasesEnvelope {
  bases?: AirtableBase[];
  offset?: string;
}

/** List every base the token can see, following Airtable's body-carried `offset` cursor to completion. */
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

/** Live base picker — must stay independent of other props, per the loader contract. */
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
