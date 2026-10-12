import { defineConfig } from 'vitest/config';
import { sessionRunReporter } from '../../scripts/lib/vitest-session-reporter.mjs';

export default defineConfig({
  test: {
    reporters: ['default', sessionRunReporter],
    // Only collected when run with `--coverage` (tools/test-explorer's
    // "branches nothing takes" column, docs/test-explorer-spec.md §6.3) —
    // `pnpm test` stays fast, coverage is opt-in.
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts', '**/index.ts'],
      reporter: ['json'],
    },
  },
});
