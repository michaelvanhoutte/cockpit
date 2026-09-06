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

/**
 * What restoring a backup's register would do to the one that is there.
 *
 * Pure, and separate from the writing, because every rule worth arguing about
 * is here: what counts as already present, and what counts as a collision. It
 * takes the two sides as plain rows so the branching is provable without a
 * register (`tests/unit/accounts/register-restore.test.ts`).
 *
 * **Missing rows are created and present ones are left exactly as they are.**
 * A restore replaces an *account's store* wholly; the register is not an
 * account's, it is the environment's, and rewriting a row would reach outside
 * what was asked for - restoring one user would rename another. So the register
 * is brought up to what the backup needs and no further.
 *
 * **A collision is refused rather than resolved.** Three of them, and they are
 * three because the register enforces three separate uniqueness rules: the id,
 * the address, and the Google identity ("Record the Google account each user
 * signs in with", issue 195). Any of them held by a *different* user means the
 * backup and the environment disagree about who somebody is, which is not a
 * thing a restore may decide.
 */
export interface RegisterPlan {
  tenantsToCreate: Record<string, unknown>[];
  usersToCreate: Record<string, unknown>[];
  collisions: string[];
}

export function planRegisterRestore(
  existing: RegisterBackup,
  incoming: RegisterBackup,
): RegisterPlan {
  const tenantsById = new Map(existing.tenants.map((row) => [row.id, row]));
  const usersById = new Map(existing.users.map((row) => [row.id, row]));
  const userByEmail = new Map(
    existing.users.filter((row) => row.email != null).map((row) => [row.email, row]),
  );
  const userBySubject = new Map(
    existing.users
      .filter((row) => row.google_subject != null)
      .map((row) => [row.google_subject, row]),
  );

  const collisions: string[] = [];
  const tenantsToCreate = incoming.tenants.filter((row) => !tenantsById.has(row.id));

  const usersToCreate: Record<string, unknown>[] = [];
  for (const user of incoming.users) {
    const held = usersById.get(user.id);
    if (held) {
      // Present already. The one thing that cannot be waved through is the same
      // person pointing somewhere else, because signing in as them would then
      // open an account the backup says is not theirs.
      if (held.account_id !== user.account_id) {
        collisions.push(
          `user ${user.id} is already in the register owning ${held.account_id}, not ${user.account_id}`,
        );
      }
      continue;
    }
    const byEmail = user.email != null ? userByEmail.get(user.email) : undefined;
    if (byEmail) {
      collisions.push(
        `the address ${user.email} is already in the register as ${byEmail.id}, not ${user.id}`,
      );
      continue;
    }
    const bySubject = user.google_subject != null ? userBySubject.get(user.google_subject) : undefined;
    if (bySubject) {
      collisions.push(
        `the Google account behind ${user.id} is already in the register as ${bySubject.id}`,
      );
      continue;
    }
    usersToCreate.push(user);
  }

  return { tenantsToCreate, usersToCreate, collisions };
}

/** A backup's register could not be put back; the message says which rows disagreed. */
export class RegisterDisagreesError extends Error {
  constructor(what: string) {
    super(what);
    this.name = 'RegisterDisagreesError';
  }
}

/**
 * Creates the register rows a restored account needs, and nothing else.
 *
 * **Written after the accounts, never before**, which is the caller's job to
 * order (`http/app.ts`) and worth saying here too: a user in the register
 * points at a store, and a user who exists before their store does is somebody
 * who can sign in to an account that is not there yet.
 *
 * Tenants before users, because `users.account_id` is a real foreign key into
 * `tenants`, and both in one batch so the register is never left holding
 * accounts whose people did not arrive.
 */
export async function restoreRegister(env: Env, incoming: RegisterBackup): Promise<RegisterPlan> {
  const plan = planRegisterRestore(await registerContents(env), incoming);
  if (plan.collisions.length > 0) {
    throw new RegisterDisagreesError(
      `the backup's register does not fit this one: ${plan.collisions.join('; ')}`,
    );
  }
  const writes = [
    ...plan.tenantsToCreate.map((row) => insertInto(env, 'tenants', row)),
    ...plan.usersToCreate.map((row) => insertInto(env, 'users', row)),
  ];
  if (writes.length > 0) await env.DB.batch(writes);
  return plan;
}

/**
 * One row, with whatever columns it carries rather than a list written here -
 * the same reason `registerContents` reads `SELECT *`. A column the register
 * gains is then restored without anybody remembering this file, and a column it
 * has lost makes the insert fail loudly instead of writing a row that is
 * missing something.
 */
function insertInto(env: Env, table: 'tenants' | 'users', row: Record<string, unknown>) {
  const columns = Object.keys(row);
  const names = columns.map((column) => `"${column.replace(/"/g, '""')}"`).join(', ');
  const places = columns.map(() => '?').join(', ');
  return env.DB.prepare(`INSERT INTO ${table} (${names}) VALUES (${places})`).bind(
    ...columns.map((column) => row[column] ?? null),
  );
}

/** Which accounts a backup of the whole environment covers, oldest name first. */
export async function registeredAccountNames(env: Env): Promise<string[]> {
  const db = createDb(env.DB);
  const rows = await db.select({ id: tenants.id }).from(tenants).orderBy(tenants.id);
  return rows.map((row) => row.id);
}
