import type { ApiKeyScheme, AuthHandle } from '../../core/auth';
import type { HttpClient } from '../../core/http/client';
import type { NextPageFn } from '../../core/http/pagination';
import { dropdown, type DropdownOption, type DropdownSchema } from '../../core/props';

/** Shared ClickUp (API v2) building blocks: the team→space→folder→list hierarchy and priority scale. */

export const CLICKUP_API_BASE = 'https://api.clickup.com/api/v2';

/** ClickUp tokens attach as a BARE `Authorization` value — no `Bearer ` prefix. */
export const clickupAuth: ApiKeyScheme = {
  type: 'apiKey',
  origins: ['https://api.clickup.com'],
  in: 'header',
  name: 'Authorization',
};

/** A ClickUp object reference (id + name), the shape reads and pickers use. */
export interface ClickupResource {
  id: string;
  name: string;
}

/** A ClickUp list, carrying the space/folder path it was found under for the picker label. */
export interface ClickupList {
  id: string;
  name: string;
  /** "Space" or "Space / Folder" — where this list lives, for the picker label. */
  path?: string;
}

/** A ClickUp task, trimmed to the fields reads and writes touch. */
export interface ClickupTask {
  id: string;
  name?: string;
  description?: string;
  status?: { status?: string } | string;
  url?: string;
  priority?: { priority?: string; id?: string } | null;
  due_date?: string | null;
}

/** ClickUp's fixed priority scale — a static picker, no fetch needed. */
export const PRIORITY_OPTIONS: DropdownOption<number>[] = [
  { label: 'Urgent', value: 1 },
  { label: 'High', value: 2 },
  { label: 'Normal', value: 3 },
  { label: 'Low', value: 4 },
];

/** Fetch the authorized workspaces (ClickUp calls them "teams"). */
export async function listTeams(http: HttpClient, auth: AuthHandle): Promise<ClickupResource[]> {
  const res = await http.get<{ teams?: ClickupResource[] }>(`${CLICKUP_API_BASE}/team`, { auth });
  return res.data.teams ?? [];
}

/** Fetch every space across all authorized teams (independent of any prop). */
export async function listSpaces(http: HttpClient, auth: AuthHandle): Promise<ClickupResource[]> {
  const teams = await listTeams(http, auth);
  const spaces: ClickupResource[] = [];
  for (const team of teams) {
    const res = await http.get<{ spaces?: ClickupResource[] }>(`${CLICKUP_API_BASE}/team/${team.id}/space`, {
      auth,
      query: { archived: false },
    });
    spaces.push(...(res.data.spaces ?? []));
  }
  return spaces;
}

/** Walk spaces → folderless lists + folders' lists; prop-independent, as the loader contract requires. */
export async function listAllLists(http: HttpClient, auth: AuthHandle): Promise<ClickupList[]> {
  const spaces = await listSpaces(http, auth);
  const lists: ClickupList[] = [];
  for (const space of spaces) {
    const folderless = await http.get<{ lists?: ClickupResource[] }>(
      `${CLICKUP_API_BASE}/space/${space.id}/list`,
      { auth, query: { archived: false } },
    );
    for (const l of folderless.data.lists ?? []) lists.push({ id: l.id, name: l.name, path: space.name });

    const folders = await http.get<{ folders?: Array<{ name: string; lists?: ClickupResource[] }> }>(
      `${CLICKUP_API_BASE}/space/${space.id}/folder`,
      { auth, query: { archived: false } },
    );
    for (const folder of folders.data.folders ?? []) {
      for (const l of folder.lists ?? []) {
        lists.push({ id: l.id, name: l.name, path: `${space.name} / ${folder.name}` });
      }
    }
  }
  return lists;
}

/** Live space picker — independent (walks teams→spaces), so it works today. */
export async function spaceOptions(http: HttpClient, auth: AuthHandle): Promise<DropdownOption<string>[]> {
  const spaces = await listSpaces(http, auth);
  return spaces.map((s) => ({ label: s.name, value: s.id }));
}

/** Live list picker — independent (walks the whole hierarchy), so it works today. */
export async function listOptions(http: HttpClient, auth: AuthHandle): Promise<DropdownOption<string>[]> {
  const lists = await listAllLists(http, auth);
  return lists.map((l) => ({ label: l.path ? `${l.path} / ${l.name}` : l.name, value: l.id }));
}

/** The required, live-picker `listId` prop shared by the task-in-a-list actions. */
export function listIdProp(): DropdownSchema<string, true> {
  return dropdown<string, true>({
    label: 'List',
    description: 'Loaded live from your ClickUp spaces and folders.',
    required: true,
    options: ({ auth, http }) => listOptions(http, auth),
  });
}

/** ClickUp pages on a 0-based `page` param; only an explicit `last_page: false` continues the walk. */
export function clickupPageCursor(): NextPageFn {
  return (response, currentUrl) => {
    const body = response.data as { last_page?: boolean };
    if (body.last_page !== false) return null;
    const url = new URL(currentUrl);
    const page = Number(url.searchParams.get('page') ?? '0');
    url.searchParams.set('page', String(page + 1));
    return url.toString();
  };
}
