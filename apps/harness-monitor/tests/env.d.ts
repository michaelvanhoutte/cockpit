import type { D1Migration } from 'cloudflare:test';
import type { Env as WorkerEnv } from '../src/worker';

/** Lets `cloudflare:test`'s `env` (typed as `Cloudflare.Env`) see our real bindings. */
declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {}
  }
}
declare module 'vitest' {
  interface ProvidedContext {
    migrations: D1Migration[];
  }
}
