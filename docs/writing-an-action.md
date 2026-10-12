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
user input (a Zendesk subdomain, a Salesforce instance). List every origin the action calls, including
hosts a provider hands back (Slack's `files.slack.com`). A request to any other origin — a typo, a
provider-supplied next-page URL, an attacker-chosen host — fails with `credential_scope` before it
is sent. On a direct connection a redirect never carries the credential to another origin, and a
body a `custom` scheme changed is never replayed to one. When user input becomes part of a hostname, pass it
through `hostLabel` so a value like `evil.com#` can't escape the template.

Use `none` for actions that need no credential (the utility actions).

### Upgrading to 0.2

`origins` is now required on every `oauth2`, `apiKey`, `basic` and `custom` scheme. Its type is a
non-empty tuple, so write the list inline (or `as const`); a plain `string[]` won't type-check. Each
entry is an origin exactly as a URL reports it — lower case, no path, no trailing slash. A missing or
malformed list fails with `invalid_input` when the action or trigger is defined. Requests outside the list
fail with the new `credential_scope` error code. An action enforces its own `origins` whatever handle
it is given, so a spec that stubs the transport still fails on a URL outside them.

Jira's `instanceUrl` (and `actions.jira.resolveJiraBase`) is now checked before any request: it must be
a site on `*.atlassian.net`, `*.jira.com` or `*.atlassian-us-gov-mod.net`, and that domain picks the
gateway. Left blank, it is refused on an API-token connection and, on a managed connection, resolves
only when the token reaches exactly one site; a URL that is none of the token's sites is refused rather
than replaced by another. Government Cloud needs `instanceUrl` set. 0.1.x fell back to the token's first
site when `instanceUrl` matched none of its sites; 0.2 refuses. A saved value that isn't one of the
token's sites must be corrected, or cleared when the token reaches a single site.

A `custom` scheme's `apply` may now be async: whatever it returns is awaited before anything is sent, so
anything it awaits delays every request until it settles. On a caller abort or a timeout the request is
abandoned without waiting for `apply` — it is not cancelled, and a retry calls it again — so pass
`request.signal` to anything it awaits. Throw an `ActionError` from it to choose the code; its
`retryable: true` retries an idempotent call, but a `POST` or `PATCH` only when its `status` is `0` and the
code isn't `transport_timeout` or `transport_interrupted`. Any other error is retried like a failure to
connect.

A call whose signal is already aborted is never sent, and a caller abort during `apply`, the retry
backoff or a `Retry-After` wait ends it at once with `transport_timeout`, `request aborted by caller`,
`retryable: false`. On a transport that ignores the signal, a request already handed to it may still
complete server-side after the caller is told it was aborted.

### Upgrading to 0.2.1

What a dropdown's options loader (`resolveOptions`) or a trigger's `runPoll`, `enable`, `disable` or
`handleRequest` throws now leaves as a scrubbed copy rather than the error itself: an `ActionError` as a
plain `ActionError` with its `code`, `status` and `retryable` kept and its `detail` scrubbed, and any
other error as a plain `Error` with the same name. What the HTTP client and an action throw are copies
the same way, so a subclass of `ActionError` leaves as a plain `ActionError` and the `cause` an action
wraps is a plain `Error`. Code that checked `instanceof` on a custom error class from those boundaries
must throw an `ActionError` and check its `code` instead. See [HTTP client](#http-client) for what is
scrubbed.

A Jira Cloud `instanceUrl` with no scheme (`your-domain.atlassian.net`), with `http:`
(`http://your-domain.atlassian.net`) or written `https:` without slashes (`https:your-domain.atlassian.net`)
resolves as that site's `https://` address; 0.2.0 refused the first two.

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

Whatever the client, an action, a dropdown's options loader (`resolveOptions`) or a trigger's `runPoll`,
`enable`, `disable` or `handleRequest` (its `verify` and `dedupeKey` included) throws leaves with a
direct connection's credential scrubbed out of its message, name, stack, `detail` (keys and values) and
every cause, in each spelling a request or an echo carries it: as given and trimmed of surrounding
whitespace, a number as its decimal text, percent-encoded as `encodeURIComponent` or `URLSearchParams`
would (either hex case), JSON-escaped (`/` as is or as `\/`), and Basic's standard padded base64
`user:pass`. That is on top of the token-shaped patterns `redactSecrets` removes. No other encoding is
derived, so a value a `custom` scheme's `apply` builds from the credential (a base64 of its own, or a
signature) is not scrubbed. A Basic username counts as the credential when the scheme sets
`keyAsUsername: true`, for an API that takes the key as the username whatever the password
(`<key>:api_token`), or when the password is blank or a placeholder shorter than four characters (Stripe,
Freshdesk). A credential value shorter than four characters, or all whitespace, is left alone, so it
can't eat ordinary words, and an `ActionError`'s `code`, `status` and `retryable` are kept as they are.
What leaves is a scrubbed copy: an `ActionError` stays one, any other error becomes an `Error` with the
same (scrubbed) name, and a value that can't be scrubbed or read (a class instance or a symbol hung on an
error, a getter that throws) is dropped. An error a transport throws that isn't an `ActionError` becomes
the failure's `cause` cut down to its name, message, stack, `code`, `errno` and `syscall`, and the same
of its own cause, so the request it carried (an axios-style `config` or `response`) is never passed on.
Scrubbing fails closed: a failure it cannot walk at all leaves as an `ActionError` carrying only its
scrubbed message and, if it was one, its `code`, `status` and `retryable`, or as code `unknown` with
message `[redacted]` when not even that can be read; text a transport's `redact` throws on becomes
`[redacted]`. A host transport that attaches a secret of its own implements `Transport.redact(text)` to
have it scrubbed too.

## Testing

Put unit tests in `<action>.spec.ts` (must run offline — stub the transport). Put real network
checks in `<action>.live.spec.ts`; they self-skip unless `ORCHESTR_LIVE=1`.

```sh
pnpm test        # offline
pnpm check       # lint + format + typecheck + test
```
