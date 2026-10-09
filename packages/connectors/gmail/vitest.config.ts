import { defineConfig } from 'vitest/config';

/**
 * The tiers that run on every change. `tests/contract/` is deliberately not
 * among them - it reaches Gmail itself, so it has a config of its own
 * (vitest.contract.config.ts) and a schedule rather than a push.
 */
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // `index.ts` is the connector itself, not a barrel (see Teams' config).
      exclude: ['src/**/*.d.ts'],
      reporter: ['json'],
    },
  },
});
