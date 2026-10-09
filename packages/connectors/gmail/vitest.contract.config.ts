import { defineConfig } from 'vitest/config';

/**
 * The contract tier for this connector (docs/testing-strategy.md, "Third
 * parties"): what every tier below it fakes, asked of Gmail itself.
 *
 * **Never per change**: it reaches the network, so it must never be picked up
 * by `pnpm test`, and a failure is Gmail having moved rather than something to
 * re-run until it passes. It needs a mailbox of its own and skips, saying so,
 * without the three `GMAIL_CONTRACT_*` secrets.
 */
export default defineConfig({
  test: {
    include: ['tests/contract/**/*.test.ts'],
    testTimeout: 30_000,
  },
});
