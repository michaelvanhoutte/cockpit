import { defineConfig } from 'vitest/config';

/**
 * The tiers that run on every change. `tests/contract/` is deliberately not
 * among them - it reaches Microsoft's own key endpoint, so it has a config of
 * its own (vitest.contract.config.ts) and a schedule rather than a push.
 */
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts', '**/index.ts'],
      reporter: ['json'],
    },
  },
});
