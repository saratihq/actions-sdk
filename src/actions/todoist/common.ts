import type { AuthHandle, OAuth2Scheme } from '../../core/auth';
import type { HttpClient } from '../../core/http/client';
import { cursorInBody, paginate } from '../../core/http/pagination';
import { dropdown, type DropdownOption, type DropdownSchema } from '../../core/props';

export const TODOIST_API_BASE = 'https://api.todoist.com/api/v1';

/** A cursor page of a v1 list endpoint. */
export interface TodoistPage<T> {
  results?: T[];
  next_cursor?: string | null;
}

/** Advance a v1 list endpoint: `next_cursor` (body) → `?cursor=` on the same URL. */
export const todoistNextPage = cursorInBody({ cursorPath: ['next_cursor'], cursorParam: 'cursor' });

/** Declared `oauth2` because a managed access token and a BYO API token both ride as the same bearer. */
export const todoistAuth: OAuth2Scheme = {
  type: 'oauth2',
  origins: ['https://api.todoist.com'],
  scopes: ['data:read_write'],
};

/** A Todoist project reference, the shape reads and the picker use. */
export interface TodoistProject {
  id: string;
  name: string;
  is_favorite?: boolean;
  url?: string;
}

/** A Todoist task, trimmed to the fields reads and writes touch. */
export interface TodoistTask {
  id: string;
  content: string;
  description?: string;
  project_id?: string;
  priority?: number;
  is_completed?: boolean;
  url?: string;
  due?: { date?: string; string?: string; datetime?: string } | null;
  labels?: string[];
}

/** Todoist's wire priority is 1 (normal) … 4 (urgent) — the INVERSE of the p1–p4 labels shown here. */
export const PRIORITY_OPTIONS: DropdownOption<number>[] = [
  { label: 'Urgent (p1)', value: 4 },
  { label: 'High (p2)', value: 3 },
  { label: 'Medium (p3)', value: 2 },
  { label: 'Normal (p4)', value: 1 },
];

/** Fetch the user's projects (cursor-paged) — shared by the project picker. */
export async function listProjects(http: HttpClient, auth: AuthHandle): Promise<TodoistProject[]> {
  return paginate<TodoistProject>({
    http,
    auth,
    url: `${TODOIST_API_BASE}/projects`,
    extractItems: (res) => (res.data as TodoistPage<TodoistProject>)?.results ?? [],
    nextPage: todoistNextPage,
    maxItems: 500,
  });
}

/** Live project picker — independent of any other prop, so it works under today's loader contract. */
export async function projectOptions(http: HttpClient, auth: AuthHandle): Promise<DropdownOption<string>[]> {
  const projects = await listProjects(http, auth);
  return projects.map((p) => ({ label: p.name, value: p.id }));
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
