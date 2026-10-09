import { defineAction } from '../../core/action';
import type { JsonValue } from '../../core/http/types';
import { json, longText, shortText } from '../../core/props';

/** GraphQL utility — a no-auth action; any credential rides the caller's `headers` prop. */

function toHeaderRecord(value: JsonValue | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) {
      if (v !== null && v !== undefined) out[k] = typeof v === 'object' ? JSON.stringify(v) : String(v);
    }
  }
  return out;
}

export const GRAPHQL_SEND_TYPE = 'graphql.send_request';
export interface GraphqlResult {
  status: number;
  data: unknown;
  errors: unknown;
}
export const sendRequest = defineAction({
  type: GRAPHQL_SEND_TYPE,
  name: 'Send Request',
  description: 'Send a GraphQL query to an endpoint and return its data/errors.',
  auth: { type: 'none' },
  props: {
    url: shortText({ label: 'Endpoint URL', required: true }),
    query: longText({ label: 'Query', required: true }),
    variables: json({
      label: 'Variables',
      description: 'A JSON object of query variables.',
      required: false,
    }),
    headers: json({ label: 'Headers', description: 'A JSON object of request headers.', required: false }),
  },
  async run({ auth, props, http }): Promise<GraphqlResult> {
    const body: { [k: string]: JsonValue } = { query: props.query };
    if (props.variables !== undefined) body.variables = props.variables;
    const res = await http.post<{ data?: unknown; errors?: unknown }>(props.url, {
      auth,
      headers: toHeaderRecord(props.headers),
      body,
      throwOnError: false,
    });
    return { status: res.status, data: res.data?.data ?? null, errors: res.data?.errors ?? null };
  },
});
