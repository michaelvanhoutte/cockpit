import type { Env as WorkerEnv } from '../../src/env.js';

/** Lets `cloudflare:test`'s `env` (typed as `Cloudflare.Env`) see our real bindings. */
declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {}
  }
}
