import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { sessionRunReporter } from '../../scripts/lib/vitest-session-reporter.mjs';

export default defineConfig({
  plugins: [react()],
  test: {
    reporters: ['default', sessionRunReporter],
    environment: 'jsdom',
    // styles.css is read as text by the dark Car view's contrast test.
    css: { include: [/styles\.css/] },
    setupFiles: ['./tests/setup.ts'],
    // Only collected when run with `--coverage` (tools/test-explorer's
    // "branches nothing takes" column, docs/test-explorer-spec.md §6.3) —
    // `pnpm test` stays fast, coverage is opt-in.
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.d.ts', '**/index.ts'],
      reporter: ['json'],
    },
  },
});
