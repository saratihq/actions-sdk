/**
 * Live-test gating. Smoke tests that hit real APIs must never run silently in a
 * unit run and must never be faked when unreachable: they self-skip with a
 * printed reason unless the environment opts in. `pnpm test:live` sets
 * `ORCHESTR_LIVE=1`; each suite additionally self-skips per provider when its
 * own credential env var is unset.
 */

export const LIVE = process.env.ORCHESTR_LIVE === '1';

/** `describe` that runs only under ORCHESTR_LIVE; otherwise skips with a visible reason. */
export function liveDescribe(name: string, fn: () => void): void {
  if (LIVE) {
    describe(name, fn);
  } else {
    describe.skip(`${name} [skipped: set ORCHESTR_LIVE=1 to run live]`, fn);
  }
}
