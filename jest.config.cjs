/**
 * Jest config mirrors workflow-service's setup (ts-jest, node env). Unit specs
 * and live smoke specs share one project; live specs self-skip unless
 * ORCHESTR_LIVE=1 is set (see src/testing/live.ts), so `pnpm test` is green
 * offline and `pnpm test:live` exercises the real APIs.
 */
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: 'src',
  testRegex: '.*\\.spec\\.ts$',
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }],
  },
  testEnvironment: 'node',
  // Live smoke tests reach real APIs; give them room beyond the 5s default.
  testTimeout: 30000,
};
