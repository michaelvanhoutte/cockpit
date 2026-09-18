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
      // **`index.ts` is not excluded here, unlike every other package**: there
      // it is a barrel worth no coverage, and here it is the connector itself -
      // the handler, the refusal each answer maps to, and the key fetch. The
      // Test Explorer names it as a source of the Capture concept
      // (tools/test-explorer/concepts.json), so leaving it out would report
      // that concept's coverage with its entry point silently missing.
      exclude: ['src/**/*.d.ts'],
      reporter: ['json'],
    },
  },
});
