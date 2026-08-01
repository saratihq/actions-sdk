export const LIVE = process.env.ORCHESTR_LIVE === '1';

/** `describe` that runs only under ORCHESTR_LIVE; otherwise skips with a visible reason. */
export function liveDescribe(name: string, fn: () => void): void {
  if (LIVE) {
    describe(name, fn);
  } else {
    describe.skip(`${name} [skipped: set ORCHESTR_LIVE=1 to run live]`, fn);
  }
}
