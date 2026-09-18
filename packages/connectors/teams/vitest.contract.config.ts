import { defineConfig } from 'vitest/config';

/**
 * The contract tier for this connector (docs/testing-strategy.md, "Third
 * parties"): what every tier below it fakes, asked of the real thing.
 *
 * **Scheduled only**, like the model's own contract suite
 * (.github/workflows/contract.yml): it reaches Microsoft over the network, so
 * it must never be picked up by `pnpm test`, and a failure is Microsoft having
 * moved rather than something to re-run until it passes.
 *
 * No credential, unlike the model's: the Bot Framework's signing keys are
 * published to anyone, which is the whole reason a bot can check a call
 * without asking Microsoft anything about itself.
 */
export default defineConfig({
  test: {
    include: ['tests/contract/**/*.test.ts'],
    testTimeout: 30_000,
  },
});
