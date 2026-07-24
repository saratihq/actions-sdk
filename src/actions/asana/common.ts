import type { AuthHandle, OAuth2Scheme } from '../../core/auth';
import type { HttpClient } from '../../core/http/client';
import { dropdown, type DropdownOption, type DropdownSchema } from '../../core/props';

/**
 * Shared Asana (API v1) building blocks: the `/api/1.0` REST endpoints, the
 * `{ data: … }` request/response envelope, OAuth2 Bearer auth, and the
 * `projects`/`stories` resource shapes are Asana's public contract. Everything is
 * JSON, so every action runs on both transports (a managed proxy, or a BYO
 * personal access token) with identical code.
 */

export const ASANA_API_BASE = 'https://app.asana.com/api/1.0';

/**
 * Asana authenticates with an OAuth2 bearer access token (managed) or a personal
 * access token attached the same way (BYO), so it is declared as `oauth2` — the
 * transport attaches the bearer either way and the action code is identical.
 */
export const asanaAuth: OAuth2Scheme = {
  type: 'oauth2',
  scopes: ['default'],
};

/** An Asana object reference (global id + name) — the shape pickers and reads use. */
export interface AsanaResource {
  gid: string;
  name: string;
}

/** An Asana task, trimmed to the fields reads and writes touch (Asana may omit any). */
export interface AsanaTask {
  gid: string;
  name?: string;
  notes?: string;
  completed?: boolean;
  due_on?: string | null;
  due_at?: string | null;
  assignee?: AsanaResource | null;
  permalink_url?: string;
  projects?: AsanaResource[];
}

/** An Asana story (a comment or activity entry on a task). */
export interface AsanaStory {
  gid: string;
  text?: string;
  type?: string;
  created_at?: string;
  created_by?: AsanaResource | null;
}

/** GET a `{ data: T }`-enveloped Asana resource and return the unwrapped `data`. */
export async function asanaGet<T>(http: HttpClient, auth: AuthHandle, url: string): Promise<T> {
  const res = await http.get<{ data: T }>(url, { auth });
  return res.data.data;
}

/** Fetch the connected user's workspaces — shared by the list read and the workspace picker. */
export async function listAsanaWorkspaces(http: HttpClient, auth: AuthHandle): Promise<AsanaResource[]> {
  const res = await http.get<{ data?: AsanaResource[] }>(`${ASANA_API_BASE}/workspaces`, {
    auth,
    query: { limit: 100, opt_fields: 'name' },
  });
  return res.data.data ?? [];
}

/**
 * Resolve a usable workspace gid: the caller's explicit choice, else the first
 * workspace on the account. Asana's `/projects` (and most list endpoints) reject
 * a call with no `workspace`/`team` scope (HTTP 400), so every project read must
 * carry one — and most accounts have exactly one workspace, so defaulting is safe.
 */
export async function resolveWorkspaceGid(
  http: HttpClient,
  auth: AuthHandle,
  workspace?: string,
): Promise<string | undefined> {
  if (workspace) return workspace;
  const workspaces = await listAsanaWorkspaces(http, auth);
  return workspaces[0]?.gid;
}

/**
 * Fetch projects in a workspace — shared by the list read and the project picker.
 * Asana requires the `workspace` scope; when the caller doesn't pass one we fall
 * back to the first workspace (see {@link resolveWorkspaceGid}).
 */
export async function listAsanaProjects(
  http: HttpClient,
  auth: AuthHandle,
  workspace?: string,
): Promise<AsanaResource[]> {
  const ws = await resolveWorkspaceGid(http, auth, workspace);
  if (!ws) return [];
  const res = await http.get<{ data?: AsanaResource[] }>(`${ASANA_API_BASE}/projects`, {
    auth,
    query: { workspace: ws, limit: 100, opt_fields: 'name', archived: false },
  });
  return res.data.data ?? [];
}

/** Live workspace picker — independent of any other prop, so it works under today's loader contract. */
export async function workspaceOptions(
  http: HttpClient,
  auth: AuthHandle,
): Promise<DropdownOption<string>[]> {
  const workspaces = await listAsanaWorkspaces(http, auth);
  return workspaces.map((w) => ({ label: w.name, value: w.gid }));
}

/** Live project picker — lists the first workspace's projects (or a given one). */
export async function projectOptions(
  http: HttpClient,
  auth: AuthHandle,
  workspace?: string,
): Promise<DropdownOption<string>[]> {
  const projects = await listAsanaProjects(http, auth, workspace);
  return projects.map((p) => ({ label: p.name, value: p.gid }));
}

/** The live workspace picker prop (optional or required per action). */
export function workspaceProp<const R extends boolean>(required: R): DropdownSchema<string, R> {
  return dropdown<string, R>({
    label: 'Workspace',
    description: 'Loaded live from your Asana workspaces.',
    required,
    options: ({ auth, http }) => workspaceOptions(http, auth),
  });
}

/** The live project picker prop (optional or required per action). */
export function projectProp<const R extends boolean>(
  required: R,
  description: string,
): DropdownSchema<string, R> {
  return dropdown<string, R>({
    label: 'Project',
    description,
    required,
    options: ({ auth, http }) => projectOptions(http, auth),
  });
}
