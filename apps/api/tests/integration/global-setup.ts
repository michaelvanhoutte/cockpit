import { readD1Migrations } from '@cloudflare/vitest-pool-workers';
import type { TestProject } from 'vitest/node';

/**
 * `readD1Migrations` imports the full `wrangler` package, which only runs on
 * the Node side. It must not be called from inside a worker-side test file
 * (see the workers-pool test's own `applyD1Migrations` call), so it runs
 * once here and the result is handed to tests via `inject('migrations')`.
 */
export default async function setup(project: TestProject) {
  const migrations = await readD1Migrations('./migrations');
  project.provide('migrations', migrations);
}

declare module 'vitest' {
  export interface ProvidedContext {
    migrations: Awaited<ReturnType<typeof readD1Migrations>>;
  }
}
