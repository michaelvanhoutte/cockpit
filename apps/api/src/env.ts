import type { D1Database } from '@cloudflare/workers-types';

/** Worker bindings. Extended as queues/secrets land (§6.3, §8). */
export interface Env {
  DB: D1Database;
}
