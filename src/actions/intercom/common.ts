import type { ApiKeyScheme, AuthHandle } from '../../core/auth';
import type { HttpClient } from '../../core/http/client';
import type { DropdownOption } from '../../core/props';

/** Shared Intercom building blocks: REST base, Bearer auth, version header, list envelope. */

export const INTERCOM_API_BASE = 'https://api.intercom.io';

/** Pin the API version so response shapes are stable regardless of the app's default. */
export const INTERCOM_HEADERS: Record<string, string> = { 'intercom-version': '2.11' };

/** Intercom authenticates with an access token as a Bearer credential (BYO paste or managed OAuth). */
export const intercomAuth: ApiKeyScheme = {
  type: 'apiKey',
  in: 'header',
  name: 'Authorization',
  prefix: 'Bearer ',
};

/** An Intercom admin (teammate), trimmed to what the admin picker uses. */
export interface IntercomAdmin {
  id: string;
  name?: string;
  email?: string;
}

/** An Intercom contact, trimmed to the fields workflows read. */
export interface IntercomContact {
  id: string;
  role: string;
  email?: string;
  name?: string;
  phone?: string;
  external_id?: string;
}

/** List envelope shared by contact/conversation reads. */
export interface IntercomList<T> {
  type: string;
  data: T[];
  total_count?: number;
  pages?: { next?: { starting_after?: string } | null };
}

/** Fetch all admins (teammates) — shared by the list action and the admin picker. */
export async function listIntercomAdmins(http: HttpClient, auth: AuthHandle): Promise<IntercomAdmin[]> {
  const res = await http.get<{ admins: IntercomAdmin[] }>(`${INTERCOM_API_BASE}/admins`, {
    auth,
    headers: INTERCOM_HEADERS,
  });
  return res.data.admins;
}

/** Live admin picker — independent of any other prop, so it works under today's loader contract. */
export async function adminOptions(http: HttpClient, auth: AuthHandle): Promise<DropdownOption<string>[]> {
  const admins = await listIntercomAdmins(http, auth);
  return admins.map((admin) => ({ label: admin.name ?? admin.email ?? admin.id, value: admin.id }));
}
