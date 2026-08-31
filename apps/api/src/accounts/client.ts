import { drizzle } from 'drizzle-orm/durable-sqlite';
import type { DurableObjectStorage } from '@cloudflare/workers-types';
import * as schema from './schema.js';

/**
 * Drizzle over one account's own SQLite storage.
 *
 * Unlike the D1 driver this one is **synchronous**: queries return their rows
 * rather than a promise for them. That is not a detail to work around - it is
 * what makes `ctx.storage.transactionSync` usable, and with it a real
 * transaction around a write instead of D1's batch-only model (the constraint
 * the architecture's data layer records having designed around). Everything
 * below `store.ts` is therefore written synchronously and calls `.all()`,
 * `.get()` and `.run()` explicitly, so that no `await` can accidentally let a
 * transaction commit before the work inside it is done.
 */
export function createAccountDb(storage: DurableObjectStorage) {
  return drizzle(storage, { schema });
}

export type AccountDb = ReturnType<typeof createAccountDb>;
