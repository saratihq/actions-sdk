import type { ApiKeyScheme, AuthHandle } from '../../core/auth';
import { ActionError } from '../../core/errors';
import type { HttpClient } from '../../core/http/client';
import type { JsonValue } from '../../core/http/types';
import type { DropdownOption } from '../../core/props';

/**
 * Shared Linear building blocks: Linear's single GraphQL endpoint, the
 * `IssueCreateInput`/`CommentCreateInput` shapes, and the `Authorization`
 * header convention. Linear's API is GraphQL, so every action POSTs a query to
 * one URL — pagination rides a cursor variable in the body, not a URL.
 */

export const LINEAR_GRAPHQL_URL = 'https://api.linear.app/graphql';

/**
 * Linear personal API keys attach as a bare `Authorization` value (no `Bearer`
 * prefix); managed OAuth tokens are attached by the proxy server-side. Declared
 * as an `apiKey` header scheme so both transports work with byte-identical action code.
 */
export const linearAuth: ApiKeyScheme = { type: 'apiKey', in: 'header', name: 'Authorization' };

/** A GraphQL response envelope: `data` on success, `errors` on failure (still HTTP 200). */
export interface GraphqlResponse<T> {
  data?: T;
  errors?: Array<{ message: string; extensions?: { code?: string } }>;
}

/**
 * Run a GraphQL operation and return its `data`. Linear (like most GraphQL APIs)
 * signals failure as **HTTP 200 with an `errors` array** — invisible to a status
 * check — so this converts that envelope into the SDK's one failure shape.
 */
export async function linearGraphql<T>(
  http: HttpClient,
  auth: AuthHandle,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  // GraphQL variables are JSON by construction; the cast is the one boundary
  // assertion, mirroring `http.get<T>` casting `unknown → T` for a response.
  const requestBody: Record<string, JsonValue> = { query };
  if (variables) requestBody.variables = variables as unknown as JsonValue;
  const res = await http.post<GraphqlResponse<T>>(LINEAR_GRAPHQL_URL, {
    auth,
    // A GraphQL mutation is not safe to blind-retry; the client already treats POST
    // as non-idempotent, so an ambiguous 5xx will not double-run it.
    body: requestBody,
  });
  const body = res.data;
  if (body.errors && body.errors.length > 0) {
    const first = body.errors[0];
    throw new ActionError({
      code: 'provider_error',
      message: `Linear API error: ${first?.message ?? 'unknown_error'}`,
      status: 400,
      retryable: false,
      detail: { provider: 'linear', code: first?.extensions?.code },
    });
  }
  if (body.data === undefined) {
    throw new ActionError({
      code: 'provider_error',
      message: 'Linear API returned no data',
      status: 502,
      retryable: true,
      detail: { provider: 'linear' },
    });
  }
  return body.data;
}

interface Connection<TNode> {
  nodes: TNode[];
  pageInfo: { hasNextPage: boolean; endCursor?: string | null };
}

/** A Linear team, trimmed to what pickers and reads use. */
export interface LinearTeam {
  id: string;
  name: string;
  key: string;
}

/** A Linear user, trimmed to what the assignee picker uses. */
export interface LinearUser {
  id: string;
  name: string;
  email?: string;
}

/** Follow a Linear cursor connection to completion (capped), collecting nodes. */
async function collectConnection<TNode, TData>(
  http: HttpClient,
  auth: AuthHandle,
  query: string,
  pick: (data: TData) => Connection<TNode>,
  maxPages = 10,
): Promise<TNode[]> {
  const out: TNode[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page += 1) {
    const data = await linearGraphql<TData>(http, auth, query, { after: cursor ?? null });
    const conn = pick(data);
    out.push(...conn.nodes);
    if (!conn.pageInfo.hasNextPage || !conn.pageInfo.endCursor) break;
    cursor = conn.pageInfo.endCursor;
  }
  return out;
}

const TEAMS_QUERY = `query Teams($after: String) {
  teams(first: 100, after: $after) { nodes { id name key } pageInfo { hasNextPage endCursor } }
}`;

const USERS_QUERY = `query Users($after: String) {
  users(first: 100, after: $after) { nodes { id name email } pageInfo { hasNextPage endCursor } }
}`;

/** Fetch every team in the workspace (shared by the list action and the team picker). */
export function listLinearTeams(http: HttpClient, auth: AuthHandle): Promise<LinearTeam[]> {
  return collectConnection<LinearTeam, { teams: Connection<LinearTeam> }>(
    http,
    auth,
    TEAMS_QUERY,
    (d) => d.teams,
  );
}

/** Fetch every user in the workspace (backs the assignee picker). */
export function listLinearUsers(http: HttpClient, auth: AuthHandle): Promise<LinearUser[]> {
  return collectConnection<LinearUser, { users: Connection<LinearUser> }>(
    http,
    auth,
    USERS_QUERY,
    (d) => d.users,
  );
}

/** Live team picker — independent of any other prop, so it works under today's loader contract. */
export async function teamOptions(http: HttpClient, auth: AuthHandle): Promise<DropdownOption<string>[]> {
  const teams = await listLinearTeams(http, auth);
  return teams.map((team) => ({ label: `${team.name} (${team.key})`, value: team.id }));
}

/** Live assignee picker — independent of team, so it works under today's loader contract. */
export async function userOptions(http: HttpClient, auth: AuthHandle): Promise<DropdownOption<string>[]> {
  const users = await listLinearUsers(http, auth);
  return users.map((user) => ({ label: user.name, value: user.id }));
}

/** Linear's fixed priority scale (0–4) — a static picker, no fetch needed. */
export const PRIORITY_OPTIONS: DropdownOption<number>[] = [
  { label: 'No priority', value: 0 },
  { label: 'Urgent', value: 1 },
  { label: 'High', value: 2 },
  { label: 'Medium', value: 3 },
  { label: 'Low', value: 4 },
];
