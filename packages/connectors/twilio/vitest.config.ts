import { defineConfig } from 'vitest/config';
import { sessionRunReporter } from '../../../scripts/lib/vitest-session-reporter.mjs';

/**
 * Unit tests only: reading a number is pure. What Twilio Verify is asked, and
 * how its answers are read, is held one tier up against `fetch`
 * (apps/api/tests/integration/connectors/texting-a-code.test.ts).
 */
export default defineConfig({
  test: {
    reporters: ['default', sessionRunReporter],
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
