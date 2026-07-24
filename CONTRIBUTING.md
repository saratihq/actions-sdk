# Contributing

Thanks for contributing to the Orchestr Actions SDK.

## Setup

```sh
pnpm install
pnpm build
pnpm test
```

Requires Node 22+ and pnpm.

## Commands

| Command | What it does |
|---|---|
| `pnpm build` | Compile to `dist/` |
| `pnpm test` | Offline unit tests |
| `pnpm test:live` | Live smoke tests against real APIs (opt-in; see the README) |
| `pnpm lint` / `pnpm lint:fix` | ESLint |
| `pnpm format` / `pnpm format:check` | Prettier |
| `pnpm check` | lint + format:check + typecheck + test — run this before opening a PR |

## Adding an action

1. Create the action under `src/actions/<app>/` with `defineAction({ ... })`.
2. Export it from the app's `index.ts` and register it in `src/actions/index.ts`.
3. Add a `*.spec.ts` covering the happy path and error handling. Real network calls belong in a
   `*.live.spec.ts` that self-skips unless `ORCHESTR_LIVE=1` — unit tests must run offline.
4. `pnpm check` green.

Triggers follow the same shape with `defineTrigger`. See
[`docs/writing-an-action.md`](docs/writing-an-action.md) and
[`docs/writing-a-trigger.md`](docs/writing-a-trigger.md).

## Code style

- TypeScript strict; no `any` on public surfaces (prefer `unknown` + narrowing).
- Let the HTTP client normalize errors — don't invent per-action error shapes.
- Action `run` code must not read the raw credential; use the injected `http` client + `auth` handle.
- Formatting is enforced by Prettier (`pnpm format`); keep diffs minimal.

## Commits & releases

This repo uses [Conventional Commits](https://www.conventionalcommits.org/) and releases
automatically via semantic-release:

- `feat: …` → minor release
- `fix: …` → patch release
- `chore:` / `docs:` / `refactor:` / `test:` → no release

Keep the subject to one line. Every push to `main` also publishes a `@canary` build for testing.

## Pull requests

Open a PR against `main` with a clear description and `pnpm check` passing. Contributions are
accepted under the repository's [license](LICENSE.md).
