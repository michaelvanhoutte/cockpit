import { and, asc, eq, isNull, like, or, sql } from 'drizzle-orm';
import { ADMIN, losingAdminIsRefused, type RegisteredUser } from '@cockpit/shared';
import { createDb } from '../db/client.js';
import { tenants, users } from '../db/schema.js';
import type { Env } from '../env.js';
import {
  foldAddress,
  idSearchPrefix,
  idsForNewUser,
  newcomerNamed,
  whatIsWrongWith,
} from './new-user.js';
import { whatStopsChanging, type UserChange } from './user-changes.js';

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
 * **`lastSignedInAt` is a column of its own** ("Show when each person last
 * signed in, on the admin page", issue 342), written by `auth/register.ts`'s
 * `startVisit` and nowhere else - a session sliding its own expiry is not a
 * fresh sign-in. `null` reads the same as "never" did before this column
 * existed: nothing here derives it from `google_subject` any more, since the
 * timestamp is now the fact and the identity would put a stable account key on
 * a page for no gain.
 *
 * Ordered by name so the list is the same list twice running. Nothing pages it:
 * the register holds the people who can sign in to one Cockpit, and a limit
 * would be machinery against a number that cannot grow that way.
 */
export async function registeredUsers(env: Env): Promise<RegisteredUser[]> {
  const rows = await peopleInRegister(createDb(env.DB))
    // Folded, because SQLite compares text as bytes by default and would put
    // every capitalised name before every lowercase one; then by id, because
    // two people may share a name and "the same list twice running" is the
    // whole claim being made.
    .orderBy(asc(sql`lower(${users.name})`), asc(users.id));

  return rows.map(asShown);
}

/**
 * A person as every admin page reads them, written once so a row cannot mean
 * one thing in the list and another in the answer to a change.
 */
function peopleInRegister(db: ReturnType<typeof createDb>) {
  return db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      role: users.role,
      // The account's *name*, joined, rather than the id it is addressed by.
      // `tenant-ada` is how the platform reaches a store and means nothing to
      // somebody reading a page; the register holds the name beside it.
      accountName: tenants.name,
      lastSignedInAt: users.lastSignedInAt,
      disabledAt: users.disabledAt,
    })
    .from(users)
    .innerJoin(tenants, eq(tenants.id, users.accountId));
}

function asShown({
  disabledAt,
  ...user
}: Awaited<ReturnType<typeof peopleInRegister>>[number]): RegisteredUser {
  return { ...user, disabled: hasNoAccess(disabledAt) };
}

/**
 * Whether this `disabled_at` means the access is gone - **one reading of the
 * column, used by the list and by the gate alike**.
 *
 * Absent means enabled, which is what let the column arrive without a backfill.
 * Anything present at all means disabled, including an empty string: the column
 * carries no CHECK (`db/schema.ts` argues why) and a restored backup writes
 * whatever its file holds, so the two sides asking it differently is a row that
 * reads "No access" on the page while that person signs in perfectly well.
 * Where the two answers differ, the safe one is the one that refuses.
 */
export function hasNoAccess(disabledAt: string | null): boolean {
  return disabledAt != null;
}

/**
 * The admins a lockout rule counts: **the ones who can actually sign in, and
 * the person being changed whatever their access.**
 *
 * The first half because an admin whose access was taken away can do nothing
 * for anybody, so counting them would tell the last admin left that somebody
 * else could put their role back.
 *
 * The second because the rule subtracts the person it is about (`admins`, in
 * the contract, is "this person included") - and leaving a *disabled* admin out
 * of their own count makes the last one who can sign in look like the last
 * admin there is. That refused an admin being demoted after being disabled,
 * which is the ordinary order to do those two things in, and left them stuck as
 * an admin until somebody handed their sign-in back.
 */
function adminsCounting(userId: string) {
  return and(eq(users.role, ADMIN), or(isNull(users.disabledAt), eq(users.id, userId)));
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
 * **Everyone arrives ordinary**, and is made an admin afterwards on their own
 * row (`changeUser`) rather than in this form: a role is a thing you can also
 * take back, and one place that sets it is one place the rules protecting it
 * live.
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

  const ids = await freeIds(env, name);
  const at = now.toISOString();
  // Not the same refusal as an unusable name, which `whatIsWrongWith` has
  // already answered above: this is a name that derives an id and finds every
  // one of them taken, which only a register holding a thousand people of one
  // name can do.
  if (!ids) {
    return { added: false, refused: `too many people are already called ${name.trim()}` };
  }

  const user: RegisteredUser = {
    id: ids.userId,
    name: name.trim(),
    email,
    role: 'user',
    accountName: name.trim(),
    lastSignedInAt: null,
    disabled: false,
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
    console.error(
      JSON.stringify({ level: 'error', message: `adding ${ids.userId} failed`, cause: String(error) }),
    );
    // **Only a uniqueness refusal is answered as one.** What that means here is
    // somebody else taking the address or an id between the read above and this
    // write, which the person can act on by trying again. Everything else - D1
    // unreachable, a column the code has not caught up with, a CHECK refusing a
    // value - is thrown, so it reaches `app.onError` as a 500 rather than
    // telling an admin to retry against a database that will refuse them for
    // ever.
    if (!isUniquenessRefusal(error)) throw error;
    return { added: false, refused: 'somebody else was added at the same moment - try again' };
  }

  return { added: true, user, accountId: ids.accountId };
}

/**
 * Somebody the register has never seen, given a user and the account they own
 * the moment they first sign in ("Sign in with any Google account, so a
 * recruiter doesn't need to be added first", issue 343) - or `null` where
 * somebody else wrote first and the register has to be read again.
 *
 * **The two rows `addUser` writes, in one write, with the Google identity
 * recorded on the way in** rather than at a later sign-in. Nobody typed this
 * address in, so the identity is the only thing saying whose row it is, and a
 * row written without it could be claimed by the next Google account arriving
 * with the same address.
 *
 * **Ordinary, like everybody added**: nothing a stranger does makes them an
 * admin.
 *
 * `null` is a uniqueness refusal and nothing else - the address, the identity
 * or the ids taken between the caller's read and this write, which is two
 * first sign-ins racing. Everything else is thrown, for the reason `addUser`
 * throws it.
 */
export async function admitNewcomer(
  env: Env,
  identity: { subject: string; email: string; name?: string },
  now: Date,
): Promise<{ user: { id: string; name: string }; accountId: string } | null> {
  const { name, idsFrom } = newcomerNamed(identity.email, identity.name);
  // The address as a second source, for a name that has used up every suffix:
  // a name is the stranger's own to choose, so a thousand Google accounts
  // called one thing must not be a way to stop the next person of that name
  // signing in at all.
  const ids = (await freeIds(env, idsFrom)) ?? (await freeIds(env, identity.email));
  // Said without the address: the register logs ids, never who they belong to.
  if (!ids) throw new Error('no ids are free for somebody signing in for the first time');
  const at = now.toISOString();

  try {
    await env.DB.batch([
      env.DB.prepare('INSERT INTO tenants (id, name, created_at) VALUES (?, ?, ?)').bind(
        ids.accountId,
        name,
        at,
      ),
      env.DB.prepare(
        'INSERT INTO users (id, name, account_id, role, email, google_subject, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).bind(ids.userId, name, ids.accountId, 'user', identity.email, identity.subject, at),
    ]);
  } catch (error) {
    if (!isUniquenessRefusal(error)) throw error;
    return null;
  }

  return { user: { id: ids.userId, name }, accountId: ids.accountId };
}

/**
 * Somebody was changed, or was not and this is why. `because` is what separates
 * a person the register does not hold - which is a wrong address, answered 404 -
 * from a change it holds and will not make.
 */
export type Changed =
  | { changed: true; user: RegisteredUser }
  | { changed: false; refused: string; because: 'nobody' | 'a rule' };

/**
 * Renames somebody and sets their role ("Rename a user, and make somebody an
 * admin", issue 232).
 *
 * **A role takes effect on the next thing that person does, and their sign-in
 * is left alone.** Nothing here touches sessions: the gate reads the register on
 * every request (`auth/register.ts`), so the row *is* what decides, and taking
 * an admin's role away while they sit on the admin page refuses their next read
 * rather than ending a sign-in they are using elsewhere.
 *
 * **One window is left open knowingly**: the rules are decided against the
 * register as it was read, so two admins demoting each other in the same
 * instant both see two admins and both writes land, leaving none - recoverable
 * only by the SQL the environment was bootstrapped with. Closing it with a
 * condition on the UPDATE was tried and taken back out: the check above answers
 * first for every request that can be made, so the condition is reachable by no
 * request, provable by no test, and carries a second copy of the refusal it
 * would have to produce. A branch nothing can reach is not a lock.
 */
export async function changeUser(
  env: Env,
  { userId, ...change }: { userId: string } & UserChange,
  askedBy: string,
): Promise<Changed> {
  const db = createDb(env.DB);
  // Together, because neither read needs the other's answer.
  const [[held], admins] = await Promise.all([
    db.select({ id: users.id, role: users.role }).from(users).where(eq(users.id, userId)),
    db.select({ id: users.id }).from(users).where(adminsCounting(userId)),
  ]);
  if (!held) return { changed: false, ...nobodyHere(userId) };

  const stops = whatStopsChanging({
    who: held,
    change,
    askedBy,
    admins: admins.map((admin) => admin.id),
  });
  if (stops) return { changed: false, refused: stops.what, because: 'a rule' };

  /**
   * Both rows in one write, as `addUser` writes them: **the account is named
   * after the person who owns it**, and leaving it behind would put "Ada
   * Lovelace" and "Ada" side by side in the list with nothing to explain the
   * difference and no way for an admin to put it right. A batch is what stops
   * the two names disagreeing for the same reason it stops a person existing
   * without their account.
   *
   * Stored trimmed, the way a name is on the way in: the box is where the
   * spaces come from and nothing downstream should have to know that.
   */
  const name = change.name.trim();
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET name = ?, role = ? WHERE id = ?').bind(
      name,
      change.role,
      userId,
    ),
    env.DB.prepare(
      'UPDATE tenants SET name = ? WHERE id = (SELECT account_id FROM users WHERE id = ?)',
    ).bind(name, userId),
  ]);

  // Read back rather than assembled here, so what a change answers and what the
  // list says are the same row read the same way - the account's name included,
  // which this function never had.
  const [after] = await peopleInRegister(db).where(eq(users.id, userId));
  // Gone between the write and the read back, which is the same answer as gone
  // before it: this page is out of date, rather than the server having broken.
  if (!after) return { changed: false, ...nobodyHere(userId) };
  return { changed: true, user: asShown(after) };
}

/** The answer for somebody the register does not hold, written once for every admin route that meets one. */
export function nobodyHere(userId: string) {
  return { refused: `${userId} is nobody here`, because: 'nobody' } as const;
}

/**
 * Whether somebody may be deleted, and the account that goes with them if so
 * ("Delete a user, and the account they owned with them", issue 234). The
 * deleting itself is `deleteUser` in `index.ts`, since it reaches a store as
 * well as this register.
 */
export type Deletable =
  | { deletable: true; accountId: string }
  | { deletable: false; refused: string; because: 'nobody' | 'a rule' };

/**
 * The refusals a deletion answers before anything is touched.
 *
 * **The two a role change and a disabling answer**, asked of somebody who will
 * not exist afterwards: deleting the last admin, or yourself, leaves the admin
 * pages reachable by nobody. The whole point of the second is that the page
 * you would undo it from is gone the moment it lands.
 *
 * **And a third of its own: an account somebody else also points at.** Adding a
 * user always makes them an account of their own, but a restored register only
 * checks that the account exists, so a row naming somebody else's is a state
 * that can arrive - and destroying that store would destroy the other person's
 * work, which nothing puts back.
 */
export async function whoCanBeDeleted(
  env: Env,
  userId: string,
  askedBy: string,
): Promise<Deletable> {
  const db = createDb(env.DB);
  const [[held], admins, sharing] = await Promise.all([
    db
      .select({ id: users.id, role: users.role, accountId: users.accountId })
      .from(users)
      .where(eq(users.id, userId)),
    db.select({ id: users.id }).from(users).where(adminsCounting(userId)),
    env.DB.prepare(
      'SELECT id FROM users WHERE account_id = (SELECT account_id FROM users WHERE id = ?) AND id != ?',
    )
      .bind(userId, userId)
      .all<{ id: string }>(),
  ]);
  if (!held) return { deletable: false, ...nobodyHere(userId) };

  const losing = losingAdminIsRefused({
    who: held,
    stillAnAdmin: false,
    askedBy,
    admins: admins.length,
  });
  if (losing) {
    return {
      deletable: false,
      because: 'a rule',
      refused:
        losing === 'the last admin'
          ? 'this is the only admin, so make somebody else an admin before deleting this one'
          : 'you cannot delete yourself - another admin can do it for you',
    };
  }

  const [other] = sharing.results;
  if (other) {
    return {
      deletable: false,
      because: 'a rule',
      refused: `${other.id} uses the same account, so deleting ${userId} would destroy their work too`,
    };
  }
  return { deletable: true, accountId: held.accountId };
}

/** The account somebody owns, by the id that addresses its store, or null for nobody. */
export async function accountOwnedBy(env: Env, userId: string): Promise<string | null> {
  const db = createDb(env.DB);
  const [held] = await db.select({ accountId: users.accountId }).from(users).where(eq(users.id, userId));
  return held?.accountId ?? null;
}

/** Ends every sign-in somebody holds: the first of deleting them's three steps. */
export async function endSignInsOf(env: Env, userId: string): Promise<void> {
  await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId).run();
}

/**
 * The last of deleting somebody's three steps: the person and their account's
 * row, in one write, so the register never holds one without the other.
 *
 * **Their sign-ins are deleted again**, for one that landed while their account
 * was being destroyed: `sessions` points at `users`, so the person could not be
 * removed while it was there.
 *
 * **So are the account's rows in D1's four old tables**, children first. An
 * account older than the stores can still have some (architecture, "D1 still
 * holds the four tables an account's data used to live in"), and three of those
 * tables hold `tenants` with a restricting foreign key - so without this the
 * register row is refused after the store is already gone, on every retry. The
 * release that drops those tables takes these four statements with it.
 */
export async function removeFromRegister(
  env: Env,
  { userId, accountId }: { userId: string; accountId: string },
): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM associations WHERE tenant_id = ?').bind(accountId),
    env.DB.prepare('DELETE FROM items WHERE tenant_id = ?').bind(accountId),
    env.DB.prepare('DELETE FROM commands WHERE tenant_id = ?').bind(accountId),
    env.DB.prepare('DELETE FROM workspaces WHERE tenant_id = ?').bind(accountId),
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId),
    env.DB.prepare('DELETE FROM users WHERE id = ?').bind(userId),
    env.DB.prepare('DELETE FROM tenants WHERE id = ?').bind(accountId),
  ]);
}

/**
 * Takes somebody's access away, or gives it back ("Take somebody's access away
 * without taking their work", issue 233).
 *
 * **Nothing they own is touched.** Their account, its workspaces and everything
 * in it are exactly as they left them - this is one column in the register, and
 * enabling them again is the same column set back. That is the whole point of
 * having this: deleting a user takes their work with it and cannot be undone,
 * so the reversible half is what an admin reaches for.
 *
 * **The sign-ins they hold go with it, in the same write.** A row saying they
 * cannot sign in while a cookie still opens the app would be access taken away
 * in name only, and the tab they left open is exactly where it would show.
 * Deleted rather than merely refused, so enabling them again does not revive a
 * sign-in they are no longer at the keyboard for - they sign in afresh.
 *
 * The two refusals are a role change's, asked of access instead: an admin who
 * cannot sign in is no more use than one who is not an admin, so disabling the
 * last one, or yourself, would leave the admin pages reachable by nobody.
 */
export async function setAccess(
  env: Env,
  { userId, disabled }: { userId: string; disabled: boolean },
  askedBy: string,
  now: Date,
): Promise<Changed> {
  const db = createDb(env.DB);
  const [[held], admins] = await Promise.all([
    db.select({ id: users.id, role: users.role }).from(users).where(eq(users.id, userId)),
    db.select({ id: users.id }).from(users).where(adminsCounting(userId)),
  ]);
  if (!held) return { changed: false, ...nobodyHere(userId) };

  const losing = losingAdminIsRefused({
    who: held,
    stillAnAdmin: !disabled,
    askedBy,
    admins: admins.length,
  });
  if (losing) {
    return {
      changed: false,
      because: 'a rule',
      refused:
        losing === 'the last admin'
          ? 'this is the only admin, so make somebody else an admin before taking this one’s access away'
          : 'you cannot take your own access away - another admin can do it for you',
    };
  }

  await env.DB.batch([
    env.DB.prepare('UPDATE users SET disabled_at = ? WHERE id = ?').bind(
      disabled ? now.toISOString() : null,
      userId,
    ),
    /**
     * **Only a disabling deletes anything.** Enabling somebody who already has
     * their access is a no-op on the column and must be one on their sign-ins
     * too: two admins with the list open, one enables Ada and she gets back to
     * work, the other's copy still shows her disabled and offers Enable - and
     * pressing it would throw her out of what she is doing for nothing.
     */
    ...(disabled ? [env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId)] : []),
  ]);

  const [after] = await peopleInRegister(db).where(eq(users.id, userId));
  if (!after) return { changed: false, ...nobodyHere(userId) };
  return { changed: true, user: asShown(after) };
}

/**
 * Whether the register refused a row for already holding one like it - a
 * primary key or one of the unique indexes - rather than for anything else.
 *
 * Read off the message, which is what SQLite gives: D1 surfaces the driver's
 * text and there is no code to switch on. Deliberately narrow, so anything this
 * does not recognise is thrown rather than reported to somebody as a conflict
 * they can retry.
 */
function isUniquenessRefusal(error: unknown): boolean {
  const said = error instanceof Error ? error.message : String(error);
  return /UNIQUE constraint failed|PRIMARY KEY must be unique/i.test(said);
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
  // Filtered to the ids this name could derive, which is what makes the read a
  // question about the people sharing a name rather than about the whole
  // register.
  //
  // **The prefix is `idSearchPrefix`'s, not the name's.** A candidate with a
  // suffix has room made for it by trimming the name, so searching on the
  // untrimmed part misses exactly the ids this is looking for - and hands out
  // one somebody already has, which the register then refuses for ever. That
  // rule lives with the derivation so the two cannot drift.
  const part = idSearchPrefix(name);
  if (!part) return null;
  const [accounts, people] = await Promise.all([
    db.select({ id: tenants.id }).from(tenants).where(like(tenants.id, `tenant-${part}%`)),
    db.select({ id: users.id }).from(users).where(like(users.id, `user-${part}%`)),
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
