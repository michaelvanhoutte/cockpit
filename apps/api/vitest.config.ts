import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';

/**
 * L1 (tests/unit) and L2 (tests/integration) share this config: the workers
 * pool runs plain unit tests fine, and only the integration tier touches the
 * real bindings declared here - D1 for the register, and the Durable Object
 * namespace an account's own store lives in (docs/testing-strategy.md, "Test
 * level definitions and dependency restrictions").
 */
export default defineConfig({
  test: {
    globalSetup: ['./tests/integration/global-setup.ts'],
    // Only collected when run with `--coverage` (tools/test-explorer's
    // "branches nothing takes" column, docs/test-explorer-spec.md §6.3) —
    // `pnpm test` stays fast, coverage is opt-in.
    //
    // provider is 'istanbul', not 'v8', unlike the other two packages: the
    // Workers runtime this pool tests inside has no `node:inspector` Session
    // API, so V8's native coverage cannot attach at all (confirmed locally —
    // it throws `ERR_METHOD_NOT_IMPLEMENTED` — and is Cloudflare's own
    // documented position: https://developers.cloudflare.com/workers/testing/vitest-integration/known-issues/#code-coverage).
    // Istanbul instruments the source at transform time instead, which works
    // inside the worker. Both providers emit the same istanbul-shaped
    // coverage-final.json, so tools/test-explorer/src/analyze/coverage.js
    // merges all three packages' output uniformly regardless of provider.
    coverage: {
      provider: 'istanbul',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts', '**/index.ts'],
      reporter: ['json'],
    },
  },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      // vitest-pool-workers' own module evaluator needs Node builtins inside
      // the worker runtime; this is test-only and does not affect the
      // deployed Worker's compatibility flags in wrangler.jsonc.
      //
      // `BACKUP_TOKEN` is a secret in a real environment, so it is in neither
      // wrangler.jsonc nor the repository - which leaves the tests needing one,
      // and it is set here rather than in a fixture so that every case reaching
      // an operator route has to carry it deliberately. An environment with no
      // secret set is the one state this cannot express, and it is asked at
      // tests/unit/auth/admin.test.ts instead.
      miniflare: {
        compatibilityFlags: ['nodejs_compat'],
        bindings: { BACKUP_TOKEN: 'test-operator-secret' },
      },
    }),
  ],
});
