import { defineConfig } from 'vitest/config';
import { sessionRunReporter } from '../../scripts/lib/vitest-session-reporter.mjs';

export default defineConfig({
  test: {
    reporters: ['default', sessionRunReporter],
    include: ['tests/unit/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts', '**/index.ts'],
      reporter: ['json'],
    },
  },
});
