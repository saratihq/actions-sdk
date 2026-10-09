# Writing an action

An action is one operation against a provider — send a message, create an issue, fetch a record.
You declare its inputs and auth, and write a `run` function.

## Anatomy

```ts
import { defineAction, shortText, longText } from '@sarati/actions-sdk';

export const createIssue = defineAction({
  type: 'github.create_issue', // '<app>.<action>' — the public identifier
  name: 'Create issue',
  description: 'Open a new issue in a repository.',
  auth: githubToken,
  props: {
    repo: shortText({ label: 'Repository', required: true, placeholder: 'owner/name' }),
    title: shortText({ label: 'Title', required: true }),
    body: longText({ label: 'Body' }),
  },
  async run({ auth, props, http }) {
    const res = await http.post(`https://api.github.com/repos/${props.repo}/issues`, {
      auth,
      body: { title: props.title, body: props.body },
    });
    return res.data;
  },
});
```

`props` inside `run` is inferred from the schema: `props.title` is `string`, an optional prop is
`string | undefined`. There is no `any`.

## Props

| Prop | Value |
|---|---|
| `shortText`, `longText` | `string` |
| `number` | `number` |
| `checkbox` | `boolean` |
| `dropdown`, `multiSelect` | `string` / `string[]` — static `choices` or an async `options` loader |
| `json` | parsed JSON |
| `file` | a file handle |
| `dateTime` | ISO 8601 string |

A `dropdown` can load its choices from the user's connection:

```ts
dropdown<string, true>({
  label: 'Channel',
  required: true,
  options: async ({ auth, http }) => {
    const channels = await listChannels(http, auth);
    return channels.map((c) => ({ label: c.name, value: c.id }));
  },
});
```

## Auth

An action declares an `AuthScheme` (`apiKey`, `oauth2`, `basic`, `custom`, or `none`) and receives
an opaque `AuthHandle` as `auth`. Pass `auth` to the `http` client and it injects the credential at
request time — action code can't read the raw secret or learn where it came from. The same action
runs with a bring-your-own credential or a managed one, unchanged.

Every scheme that carries a credential declares the `origins` it may be sent to:

```ts
const githubToken: ApiKeyScheme = {
  type: 'apiKey',
  origins: ['https://api.github.com'],
  in: 'header',
  name: 'Authorization',
  prefix: 'Bearer ',
};
```

An entry is an exact origin, or `https://*.example.com` for any subdomain when the host comes from
user input (a Zendesk subdomain, a Salesforce instance). A request to any other origin — a typo, a
provider-supplied next-page URL, an attacker-chosen host — fails with `credential_scope` before it
is sent, and a redirect never carries the credential to a different origin. When user input becomes
part of a hostname, pass it through `hostLabel` so a value like `evil.com#` can't escape the template.

Use `none` for actions that need no credential (the utility actions).

## HTTP client

The injected `http` client handles the parts every integration repeats:

```ts
// Requests
await http.get(url, { auth, query: { page: 2 } });
await http.post(url, { auth, body: { … } });

// Retries honor Retry-After and are automatic for idempotent, retryable failures.
```

For multi-page reads, the `paginate` helper covers cursor-in-body and `Link`-header APIs — see
`slack.list_channels` for a worked example. Every failure is normalized to
`{ status, message, retryable }`, so don't build your own error shape.

## Testing

Put unit tests in `<action>.spec.ts` (must run offline — stub the transport). Put real network
checks in `<action>.live.spec.ts`; they self-skip unless `ORCHESTR_LIVE=1`.

```sh
pnpm test        # offline
pnpm check       # lint + format + typecheck + test
```
