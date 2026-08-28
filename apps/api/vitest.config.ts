import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';

/**
 * L1 (tests/unit) and L2 (tests/integration) share this config: the workers
 * pool runs plain unit tests fine, and only the integration tier touches the
 * real D1 binding declared here (see docs/testing-strategy.md §2).
 */
export default defineConfig({
  test: {
    globalSetup: ['./tests/integration/global-setup.ts'],
  },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      // vitest-pool-workers' own module evaluator needs Node builtins inside
      // the worker runtime; this is test-only and does not affect the
      // deployed Worker's compatibility flags in wrangler.jsonc.
      miniflare: { compatibilityFlags: ['nodejs_compat'] },
    }),
  ],
});
