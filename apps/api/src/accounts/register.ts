import { eq } from 'drizzle-orm';
import { createDb } from '../db/client.js';
import { tenants } from '../db/schema.js';
import type { Env } from '../env.js';

/**
 * The register: which accounts exist. It stays in D1 rather than moving into
 * the stores, because it is queried *before* any account is known - there is
 * nowhere else to ask - and because a store is addressed by name, which means
 * `idFromName` happily hands back an empty object for an account nobody ever
 * created. The register is what turns that into an error.
 *
 * It is also physically separate from account data, which the platform then
 * enforces: D1 cannot join across bindings, and a Worker cannot join D1 to a
 * Durable Object at all.
 */
export async function accountIsRegistered(env: Env, accountName: string): Promise<boolean> {
  const db = createDb(env.DB);
  const rows = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, accountName));
  return rows.length > 0;
}
