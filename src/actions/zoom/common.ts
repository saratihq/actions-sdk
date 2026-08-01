import type { AuthHandle, OAuth2Scheme } from '../../core/auth';
import type { HttpClient } from '../../core/http/client';
import { dropdown, type DropdownOption, type DropdownSchema } from '../../core/props';

export const ZOOM_API_BASE = 'https://api.zoom.us/v2';

/** OAuth2 bearer auth; scopes must stay in Zoom's GRANULAR form — a BYO own-client app cannot request the retiring classic names. */
export const zoomAuth: OAuth2Scheme = {
  type: 'oauth2',
  scopes: ['meeting:read:meeting', 'meeting:write:meeting', 'user:read:user', 'user:read:list_users:admin'],
};

/** A Zoom meeting (as returned by create/get). Fields Zoom may omit are optional. */
export interface ZoomMeeting {
  id: number;
  uuid?: string;
  host_id?: string;
  host_email?: string;
  topic: string;
  type: number;
  status?: string;
  start_time?: string;
  duration?: number;
  timezone?: string;
  agenda?: string;
  created_at?: string;
  join_url?: string;
  start_url?: string;
}

/** One entry in the meetings list (a trimmed {@link ZoomMeeting}). */
export interface ZoomMeetingListEntry {
  id: number;
  uuid?: string;
  topic: string;
  type: number;
  start_time?: string;
  duration?: number;
  timezone?: string;
  join_url?: string;
}

/** A Zoom user, trimmed to what the user picker uses. */
export interface ZoomUser {
  id: string;
  email?: string;
  first_name?: string;
  last_name?: string;
}

/** Fetch the account's users — backs the (optional) host picker. */
export async function listUsers(http: HttpClient, auth: AuthHandle): Promise<ZoomUser[]> {
  const res = await http.get<{ users?: ZoomUser[] }>(`${ZOOM_API_BASE}/users`, {
    auth,
    query: { page_size: 300, status: 'active' },
  });
  return res.data.users ?? [];
}

/** Live host picker; needs `user:read:list_users:admin` — without it Zoom 4xxs and the host degrades the field to free text. */
export async function userOptions(http: HttpClient, auth: AuthHandle): Promise<DropdownOption<string>[]> {
  const users = await listUsers(http, auth);
  return users.map((user) => {
    const name = [user.first_name, user.last_name].filter(Boolean).join(' ').trim();
    const label = name && user.email ? `${name} (${user.email})` : user.email || name || user.id;
    return { label, value: user.id };
  });
}

/** The optional, live-picker `userId` prop shared by create/list. Blank = the connected user ("me"). */
export function userIdProp(): DropdownSchema<string, false> {
  return dropdown<string, false>({
    label: 'Host',
    description: 'The meeting host — loaded live. Leave blank to use the connected user.',
    required: false,
    options: ({ auth, http }) => userOptions(http, auth),
  });
}
