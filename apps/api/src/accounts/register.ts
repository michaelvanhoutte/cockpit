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

/** The register as a backup holds it. */
export interface RegisterBackup {
  tenants: Record<string, unknown>[];
  users: Record<string, unknown>[];
}

/**
 * The register, for a backup: which accounts exist and who the users are.
 *
 * **Sign-ins are deliberately not here.** They slide, they expire, and the row
 * is the authority rather than the cookie - so restoring one would bring back a
 * sign-in somebody ended, which is the one thing signing out is supposed to
 * make final. Nothing is lost by leaving them out: a sign-in is re-made by
 * signing in.
 *
 * **Columns are not written down.** `SELECT *` rather than a list, so a column
 * the register gains is in the backup without anyone remembering this file -
 * which `email` and `google_subject` would already have needed ("Record the
 * Google account each user signs in with", issue 195).
 */
export async function registerContents(env: Env): Promise<RegisterBackup> {
  const [tenantRows, userRows] = await Promise.all([
    env.DB.prepare('SELECT * FROM tenants ORDER BY id').all<Record<string, unknown>>(),
    env.DB.prepare('SELECT * FROM users ORDER BY id').all<Record<string, unknown>>(),
  ]);
  return { tenants: tenantRows.results, users: userRows.results };
}

/** Which accounts a backup of the whole environment covers, oldest name first. */
export async function registeredAccountNames(env: Env): Promise<string[]> {
  const db = createDb(env.DB);
  const rows = await db.select({ id: tenants.id }).from(tenants).orderBy(tenants.id);
  return rows.map((row) => row.id);
}
