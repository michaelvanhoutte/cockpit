import { asc, eq, sql } from 'drizzle-orm';
import type { RegisteredUser } from '@cockpit/shared';
import { createDb } from '../db/client.js';
import { tenants, users } from '../db/schema.js';
import type { Env } from '../env.js';
import { foldAddress, idsForNewUser, whatIsWrongWith } from './new-user.js';

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

/**
 * Everyone this Cockpit knows, for the admin pages.
 *
 * **It crosses every account on purpose**, which nothing else in the product
 * does: the register is the environment's rather than an account's, and who can
 * sign in is exactly the question an admin is here to answer. The rule it looks
 * like it breaks - a query scoped to the account the session names - is about
 * an account's *data*, which lives in a store this cannot reach at all.
 *
 * **`hasSignedIn` is derived rather than stored.** The register records the
 * Google identity at somebody's first sign-in, so its presence is the fact, and
 * publishing the identity itself would put a stable account key on a page for
 * no gain.
 *
 * Ordered by name so the list is the same list twice running. Nothing pages it:
 * the register holds the people who can sign in to one Cockpit, and a limit
 * would be machinery against a number that cannot grow that way.
 */
export async function registeredUsers(env: Env): Promise<RegisteredUser[]> {
  const rows = await createDb(env.DB)
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      role: users.role,
      // The account's *name*, joined, rather than the id it is addressed by.
      // `tenant-ada` is how the platform reaches a store and means nothing to
      // somebody reading a page; the register holds the name beside it.
      accountName: tenants.name,
      googleSubject: users.googleSubject,
    })
    .from(users)
    .innerJoin(tenants, eq(tenants.id, users.accountId))
    // Folded, because SQLite compares text as bytes by default and would put
    // every capitalised name before every lowercase one; then by id, because
    // two people may share a name and "the same list twice running" is the
    // whole claim being made.
    .orderBy(asc(sql`lower(${users.name})`), asc(users.id));

  return rows.map(({ googleSubject, ...user }) => ({
    ...user,
    hasSignedIn: googleSubject !== null,
  }));
}

/**
 * Somebody was added, or was not and this is why.
 *
 * **`accountId` is carried beside the user and is not `user.accountName`.** The
 * two are different things that read alike: the contract's `accountName` is the
 * account's *name*, which is what an admin sees, while what addresses the store
 * is the register's id (`tenant-anna`). Anything opening the account needs this
 * one.
 */
export type Added =
  | { added: true; user: RegisteredUser; accountId: string }
  | { added: false; refused: string };

/**
 * Adds a person and the account they own ("Add a user on the admin page, so a
 * second person no longer needs SQL", issue 231).
 *
 * **Both rows in one write.** A person pointing at an account that is not there
 * is somebody whose every request fails on a foreign key they cannot see, and a
 * batch is what makes that state unreachable rather than merely unlikely.
 *
 * **The refusals are decided against the register as it was read**, so the write
 * is guarded again by the register's own uniqueness: if somebody else takes the
 * address in between, the insert fails and this says so rather than reporting a
 * person who is not there. The four rules are the register's, not this
 * function's - an account's id, a user's id, the address, and the Google
 * identity - which is why the check is a query against them rather than a list
 * kept here.
 *
 * **Everyone arrives ordinary.** Choosing a role while adding waits for
 * "Rename a user, and make somebody an admin" (issue 232); until then the only
 * admin is the one the environment was bootstrapped with.
 */
export async function addUser(
  env: Env,
  { name, address }: { name: string; address: string },
  now: Date,
): Promise<Added> {
  const wrong = whatIsWrongWith({ name, address });
  if (wrong) return { added: false, refused: wrong.what };

  const db = createDb(env.DB);
  const email = foldAddress(address);
  const [held] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
  if (held) return { added: false, refused: `${email} is already how ${held.id} signs in` };

  const [ids, at] = [await freeIds(env, name), now.toISOString()];
  if (!ids) return { added: false, refused: `${name.trim()} leaves nothing an account could be named after` };

  const user: RegisteredUser = {
    id: ids.userId,
    name: name.trim(),
    email,
    role: 'user',
    accountName: name.trim(),
    hasSignedIn: false,
  };

  try {
    await env.DB.batch([
      env.DB.prepare('INSERT INTO tenants (id, name, created_at) VALUES (?, ?, ?)').bind(
        ids.accountId,
        user.name,
        at,
      ),
      env.DB.prepare(
        'INSERT INTO users (id, name, account_id, role, email, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).bind(ids.userId, user.name, ids.accountId, user.role, email, at),
    ]);
  } catch (error) {
    // What is left to fail here is the register refusing a row somebody else
    // wrote between the read above and this write - the address, or an id. Said
    // as a refusal rather than thrown as a 500, because it is a true answer to
    // what was asked and the person can act on it by trying again.
    console.error(JSON.stringify({ level: 'error', message: `adding ${ids.userId} failed`, cause: String(error) }));
    return { added: false, refused: `somebody else was added at the same moment - try again` };
  }

  return { added: true, user, accountId: ids.accountId };
}

/**
 * The first pair of ids nothing in the register holds.
 *
 * One query rather than one per candidate: the ids are derived from a name, and
 * the only way a second query would be reached is two people of the same name,
 * so the whole set of ids starting with this name is read once and answered
 * from.
 */
async function freeIds(env: Env, name: string) {
  const db = createDb(env.DB);
  const [accounts, people] = await Promise.all([
    db.select({ id: tenants.id }).from(tenants),
    db.select({ id: users.id }).from(users),
  ]);
  const held = new Set([...accounts.map((row) => row.id), ...people.map((row) => row.id)]);
  return idsForNewUser(name, ({ accountId, userId }) => held.has(accountId) || held.has(userId));
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
 * **A collision is refused rather than resolved.** Four of them, and they are
 * four because the register enforces four separate uniqueness rules: an
 * account's id, a user's id, the address, and the Google identity ("Record the
 * Google account each user signs in with", issue 195). Any of them held by
 * something that is not the row claiming it means the backup and the
 * environment disagree about who somebody is, which is not a thing a restore
 * may decide.
 */
export interface RegisterPlan {
  tenantsToCreate: Record<string, unknown>[];
  usersToCreate: Record<string, unknown>[];
  collisions: string[];
  /**
   * Rows nothing could insert whatever the register holds - a row with no
   * columns, or one missing what the plan itself reads. Separate from a
   * collision because it is a broken file rather than a disagreement, and it
   * answers differently.
   */
  unusable: string[];
}

/**
 * The columns a row must carry to be insertable, per table.
 *
 * Asked of SQLite rather than written down (`columnsEveryRowNeeds`), for the
 * reason the table order is: a list here would go stale the day the register
 * gains a NOT NULL column, and the failure would be a constraint error at
 * insert time - a 500 - rather than the refusal this exists to give.
 */
export type ColumnsNeeded = { tenants: readonly string[]; users: readonly string[] };

export function planRegisterRestore(
  existing: RegisterBackup,
  incoming: RegisterBackup,
  needs: ColumnsNeeded = { tenants: ['id'], users: ['id', 'account_id'] },
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
  const unusable: string[] = [
    ...unusableRows('an account', incoming.tenants, needs.tenants),
    ...unusableRows('a user', incoming.users, needs.users),
  ];

  // **What this backup has already asked for**, kept beside what the register
  // holds. Without it a file naming the same thing twice passed both rows
  // through as rows to create, and the register's own primary key or unique
  // index refused the second at insert time, as a 500 rather than as the
  // collision it is. A backup is a file, so two rows saying different things
  // about one account or one person is a state that can really arrive.
  //
  // **Every uniqueness the register enforces needs one of these**, which is
  // written here because it was got wrong twice: the check landed on users and
  // not on accounts, five lines apart, under this same comment. The register
  // enforces four - an account's id, a user's id, their address and their
  // Google identity - and `alreadyClaimed` is each of them once.
  const claimed = { tenant: new Set<unknown>(), user: new Set<unknown>() };
  const takenEmails = new Set<unknown>();
  const takenSubjects = new Set<unknown>();

  const tenantsToCreate: Record<string, unknown>[] = [];
  for (const account of incoming.tenants) {
    if (alreadyClaimed(claimed.tenant, account.id)) {
      collisions.push(`the backup names account ${account.id} twice`);
      continue;
    }
    if (!tenantsById.has(account.id)) tenantsToCreate.push(account);
  }

  const usersToCreate: Record<string, unknown>[] = [];
  for (const user of incoming.users) {
    if (alreadyClaimed(claimed.user, user.id)) {
      collisions.push(`the backup names user ${user.id} twice`);
      continue;
    }
    if (user.email != null && alreadyClaimed(takenEmails, user.email)) {
      collisions.push(`the backup gives the address ${user.email} to more than one user`);
      continue;
    }
    if (user.google_subject != null && alreadyClaimed(takenSubjects, user.google_subject)) {
      collisions.push(`the backup gives one Google account to more than one user`);
      continue;
    }

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

  return { tenantsToCreate, usersToCreate, collisions, unusable };
}

/**
 * Which columns the register will refuse a row for lacking: the ones declared
 * NOT NULL with nothing to fall back on.
 *
 * **Asked of the database rather than written down here.** A list would go
 * stale the day the register gains a NOT NULL column, and silently: the row
 * would pass this check and fail its INSERT, which is a 500 at the very moment
 * a restore can no longer be undone - the accounts have already been replaced
 * by then. `dflt_value` is what excuses a column, since one with a default is
 * one the insert can leave out.
 */
async function columnsEveryRowNeeds(env: Env): Promise<ColumnsNeeded> {
  const [tenants, users] = await Promise.all([requiredIn(env, 'tenants'), requiredIn(env, 'users')]);
  return { tenants, users };
}

async function requiredIn(env: Env, table: 'tenants' | 'users'): Promise<string[]> {
  const { results } = await env.DB.prepare(`PRAGMA table_info(${table})`).all<{
    name: string;
    notnull: number;
    dflt_value: unknown;
  }>();
  return results.filter((column) => column.notnull === 1 && column.dflt_value == null).map((column) => column.name);
}

/**
 * Whether the backup has already claimed this value, remembering it if not.
 *
 * The claiming and the asking are one call on purpose: two lines that have to
 * stay together are two lines one of them can be written without, which is how
 * a check ended up covering users and not accounts.
 */
function alreadyClaimed(seen: Set<unknown>, value: unknown): boolean {
  if (seen.has(value)) return true;
  seen.add(value);
  return false;
}

/**
 * Rows nothing could write, whatever the register holds.
 *
 * **The wire schema cannot catch these.** A row is an open record there, so
 * `{}` is a valid one - the same gap `sameShapeThroughout` covers on the
 * account side, and this is the register's half of it. Without it an empty row
 * reached the insert, which built `INSERT INTO tenants () VALUES ()` and failed
 * as a syntax error the route does not map: a 500 where a refusal belonged.
 *
 * The columns required are the ones this plan itself reads, so a row missing
 * one cannot be reasoned about at all rather than merely being sparse - every
 * other column is left to the register's own constraints.
 */
function unusableRows(
  what: string,
  rows: readonly Record<string, unknown>[],
  needs: readonly string[],
): string[] {
  const said: string[] = [];
  for (const [at, row] of rows.entries()) {
    if (Object.keys(row).length === 0) {
      said.push(`${what} at position ${at + 1} carries no columns at all`);
      continue;
    }
    const missing = needs.filter((column) => row[column] == null);
    if (missing.length > 0) {
      said.push(`${what} at position ${at + 1} has no ${missing.join(' and no ')}`);
    }
  }
  return said;
}

/** A row in the backup's register is one nothing could write, whatever is there. */
export class RegisterRowUnusableError extends Error {
  constructor(what: string) {
    super(what);
    this.name = 'RegisterRowUnusableError';
  }
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
  const [held, needs] = await Promise.all([registerContents(env), columnsEveryRowNeeds(env)]);
  const plan = planRegisterRestore(held, incoming, needs);
  // Before the collisions, because a row nothing could write is a broken file
  // rather than a disagreement, and saying "the register does not fit" of it
  // would send somebody to look at the register.
  if (plan.unusable.length > 0) {
    throw new RegisterRowUnusableError(
      `that register cannot be put back: ${plan.unusable.join('; ')}`,
    );
  }
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
