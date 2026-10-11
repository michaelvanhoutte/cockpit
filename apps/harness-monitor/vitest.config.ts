import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import path from 'node:path';

/** L1 (tests/unit) and L2 (tests/integration) share this config, as Cockpit's API does. */
export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, 'migrations'));
  return {
    test: {
      testTimeout: 20_000,
      disableConsoleIntercept: true,
      setupFiles: ['./tests/integration/apply-migrations.ts'],
      provide: { migrations },
      coverage: { provider: 'istanbul' as const, include: ['src/**/*.ts'], reporter: ['json'] },
    },
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          compatibilityFlags: ['nodejs_compat'],
          bindings: { HARNESS_WRITE_KEY: 'test-write-key', PAGE_CACHE_SECONDS: '0' },
        },
      }),
    ],
  };
});
