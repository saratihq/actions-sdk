# Orchestr Actions SDK

A typed SDK for building **actions and triggers** for the Orchestr automation platform.
Define an integration once — its inputs, auth, and run logic — and it runs the same whether
the user brings their own credentials or connects through a managed provider.

## Install

```sh
pnpm add @sarati/actions-sdk
```

Requires Node 22+.

## Quick start

```ts
import { defineAction, dropdown, longText } from '@sarati/actions-sdk';

export const sendChannelMessage = defineAction({
  type: 'slack.send_channel_message',
  name: 'Send message to a channel',
  description: 'Post a message to a Slack channel.',
  auth: slackOAuth,
  props: {
    channel: dropdown<string, true>({
      label: 'Channel',
      required: true,
      // Choices loaded live from the user's connection.
      options: async ({ auth, http }) => {
        const channels = await listSlackChannels(http, auth);
        return channels.map((c) => ({ label: `#${c.name}`, value: c.id }));
      },
    }),
    text: longText({ label: 'Message', required: true }),
  },
  async run({ auth, props, http }) {
    // The credential is injected at request time; action code never reads it.
    const res = await http.post('https://slack.com/api/chat.postMessage', {
      auth,
      body: { channel: props.channel, text: props.text },
    });
    return assertSlackOk(res.data);
  },
});
```

`props` inside `run` is fully inferred from the schema — no `any`.

## Concepts

- **Actions & triggers** — `defineAction` / `defineTrigger`. Triggers support two strategies:
  **polling** (with dedup + a watermark cursor) and **webhook** (handshake, signature
  verification, payload → events). A webhook trigger can register a real provider subscription
  per connection via `onEnable({ webhookUrl, secret })` and remove it via `onDisable(handle)`.
- **Prop schemas** — `shortText`, `longText`, `number`, `checkbox`, `dropdown` (static choices or
  an async `options({ auth, http })` loader), `multiSelect`, `json`, `file`, `dateTime`.
- **HTTP client** — auth injected through a pluggable transport, pagination helpers (cursor and
  `Link`-header), retry-with-backoff that honors `Retry-After` and idempotency, per-request
  timeouts, and error normalization to a single shape `{ status, message, retryable }`.
- **Auth** — an action declares an `AuthScheme` and receives an opaque `AuthHandle`. The
  credential is resolved behind the handle and is never readable by action code, so the same
  action runs with direct (bring-your-own) or managed credentials with no branching.

See [`docs/writing-an-action.md`](docs/writing-an-action.md) and
[`docs/writing-a-trigger.md`](docs/writing-a-trigger.md) for full walkthroughs.

## Included actions

Auth-free utility actions with zero runtime dependencies (Node built-ins only) — they run
in-process and offline:

| App | Actions | App | Actions |
|---|---|---|---|
| `http` | `send_request`, `parse_url` | `crypto` | hash, hmac, rsa, base64, password |
| `text` | concat, replace, split, find, … | `csv` | csv ↔ json |
| `date` | format, diff, add/subtract, … | `xml` | json → xml |
| `math` | add, subtract, multiply, divide, mod, random | `data_mapper` | field mapping |
| `json` | to-text, to-json, merge | `graphql` | `send_request` |
| `hackernews` | `fetch_top_stories` | `binance` | `fetch_crypto_pair_price` |

Utility actions that use a vetted, permissively-licensed library (MIT/Apache/BSD/ISC only):

| App | Actions | Library |
|---|---|---|
| `pdf` | extract text, page count, create, merge, split, stamp text/image | `pdf-lib`, `unpdf` |
| `qrcode` | `text_to_qrcode` | `qrcode` |
| `text` | markdown ↔ html, extract from html | `showdown`, `turndown`, `node-html-parser` |
| `json` | `run_jsonata_query` | `jsonata` |
| `csv` | `convert_excel_to_csv` | `exceljs` |
| `xml` | `convert_xml_to_json` | `fast-xml-parser` |

Plus reference provider actions and triggers for Slack and GitHub, and polling triggers
(`http.new_item`, `hackernews.new_story`, `rss.new_item`, `slack.new_channel`).

## Testing

```sh
pnpm test        # offline unit tests
pnpm test:live   # live smoke tests against real APIs (opt-in — see below)
pnpm check       # lint + format:check + typecheck + test
```

Live tests hit real APIs over the direct transport and self-skip unless opted in:

- `ORCHESTR_LIVE=1` — enable the live suites.
- The GitHub suites need only `ORCHESTR_LIVE=1` (they read a public repo unauthenticated).
- The AI `generate_text` suite additionally reads a provider key per model it exercises
  (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `MISTRAL_API_KEY`); each provider
  self-skips when its key is unset.

## Releases

Published to npm as `@sarati/actions-sdk`, automated via semantic-release:

- **Stable** — a merge to `main` with a `feat:`/`fix:` commit cuts a new version (git tag + GitHub
  release with notes + npm `@latest`). `chore:`/`docs:` commits don't release.
- **Canary** — every push to `main` publishes `0.0.0-canary.<sha>` under the `@canary` dist-tag.
- **Prerelease** — pushes to the `next` branch publish under `@next`.

Released versions live in the git tags and [GitHub Releases](https://github.com/saratihq/actions-sdk/releases)
— the `version` in `package.json` is a placeholder, and each published tarball carries its own
`CHANGELOG.md`.

```sh
pnpm add @sarati/actions-sdk          # latest stable
pnpm add @sarati/actions-sdk@canary   # newest main build
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT — see [LICENSE.md](LICENSE.md).
