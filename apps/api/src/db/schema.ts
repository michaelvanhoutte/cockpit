import { check, index, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import type { Role } from '@cockpit/shared';

/**
 * The register, in D1: which accounts exist, who the users are and which of
 * them are currently signed in - and nothing else. An account's own data - its
 * workspaces, dashboards, items, associations and change log - lives in that
 * account's store (src/accounts/schema.ts), never here.
 *
 * The three tables here are the register precisely because they are all
 * questions asked *before* any account is known: which people can sign in,
 * whether this cookie belongs to one of them, and which account that person
 * owns. There is nowhere else to ask them, and the split is then enforced by
 * the platform rather than by discipline - a Worker cannot join D1 to a Durable
 * Object at all.
 *
 * The split is the account storage decision
 * ([account-storage-options.md](../../../../docs/account-storage-options.md)):
 * the register is global, queried before any account is known, and small, so it
 * stays where a query can reach it without a name to address. The table is
 * still called `tenants`, and the column that carries an account's name through
 * every row of its store is still `tenant_id` - renaming them would be a
 * separate change, and the schema conventions the architecture records are
 * written in those words.
 *
 * The conventions the database enforces rather than trusting its callers to
 * ("The database is the second lock" in the architecture's schema
 * conventions) apply here as much as in a store: the table is STRICT, and a
 * CHECK holds `created_at` to an ISO-8601 instant. drizzle-kit cannot emit
 * STRICT, so every migration adds it by hand and
 * tests/integration/db/constraints.test.ts is the guard that a regenerated one
 * has not quietly dropped it.
 *
 * **D1 still has the four tables an account's data used to live in**, and this
 * file deliberately no longer describes them. Removing them is a *contract*
 * step and belongs to a later release, per "Migrations and rollback" in
 * docs/deployment.md: every deploy applies migrations before the new code goes
 * live, so dropping them in the same release would leave the old code reading
 * tables that are already gone, and promoting an earlier commit - the first and
 * cheapest way back - would leave it that way. Keeping them is also what makes
 * that rollback work at all, since the rows they hold are exactly what the old
 * code reads. `drizzle-kit generate` will emit the four `DROP TABLE`s the day
 * that release is taken; until then it is one command away and deliberately not
 * run.
 */
export const tenants = sqliteTable(
  'tenants',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    createdAt: text('created_at').notNull(),
  },
  () => [
    check(
      'tenants_created_at_is_timestamp',
      sql.raw(
        `created_at IS NULL OR (datetime(created_at) IS NOT NULL` +
          ` AND substr(created_at, 11, 1) = 'T' AND substr(created_at, -1) = 'Z'` +
          ` AND length(created_at) >= 20` +
          ` AND date(created_at) = substr(created_at, 1, 10))`,
      ),
    ),
  ],
);

/**
 * The same "this column holds an ISO-8601 instant" CHECK the register's own
 * `created_at` carries, written once now that four more columns need it. The
 * SQL it emits is identical, so a regenerated migration is unchanged by it.
 */
function isTimestamp(column: string) {
  return sql.raw(
    `${column} IS NULL OR (datetime(${column}) IS NOT NULL` +
      ` AND substr(${column}, 11, 1) = 'T' AND substr(${column}, -1) = 'Z'` +
      ` AND length(${column}) >= 20` +
      ` AND date(${column}) = substr(${column}, 1, 10))`,
  );
}

/**
 * The people who use this Cockpit. One user owns one account, which is what
 * makes signing in as somebody else land you somewhere completely separate:
 * `account_id` is the only place that mapping exists, it is read by the gate
 * and by nothing else, and every account query downstream is already addressed
 * by that name.
 *
 * **`role` decides who can open the admin pages** ("See who can sign in, on a
 * page only an admin can open", issue 230), which is `auth/admin.ts` and is the
 * only thing that reads it. It was carried unenforced from "Sign in by picking
 * a name, each user in their own account" (issue 86) so that role logic would
 * not have to be retrofitted through every query later - the bet that turn
 * made, and the gate arrived without a migration behind it.
 *
 * **There is no secret on a user, and there will not be one.** Google-only and
 * passwordless means no password storage, no reset flow and no email
 * verification anywhere in the system (docs/architecture.md, "App login").
 * What identifies a person instead is the two columns below.
 *
 * **Both are optional, and what enforces them is a unique index rather than
 * NOT NULL** ("Record the Google account each user signs in with", issue 195).
 * Requiring them would mean rebuilding this table, which is the manoeuvre that
 * nearly emptied the register once ("Make the database enforce the schema
 * conventions, not just the callers", issue 69) - and a row with no address
 * needs no constraint to keep it out, because there is no address for a Google
 * account to match. Nothing reads either column yet; the sign-in that does is
 * "Sign in with Google, and retire the list of names" (issue 196).
 */
export const users = sqliteTable(
  'users',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    /** The account whose store holds this user's workspaces and items. */
    accountId: text('account_id')
      .notNull()
      .references(() => tenants.id),
    // Typed as the two roles there are, which the CHECK below already enforces:
    // the constraint is what makes it true and this is what lets the compiler
    // know, so a read of this column does not widen to `string` on its way into
    // the contract.
    role: text('role').$type<Role>().notNull(),
    /**
     * The address of the Google account this person signs in with, and how
     * the register recognises them the first time: an admin adds somebody by
     * it, and somebody who signs in unadded arrives with it.
     *
     * **An address is held as it is written, and the index that keeps two
     * people from sharing one compares it the same way.** So whatever comes to
     * write one - signing in, or adding a user from the command line - is what
     * has to settle on a single spelling before it gets here, since two rows
     * differing only in case would both be allowed in and only one of them
     * would ever be found.
     */
    email: text('email'),
    /**
     * What Google calls this person, learned the first time they sign in.
     *
     * It is kept *as well as* the address because the two answer different
     * questions: an address is how somebody is recognised the first time, and can be
     * changed or handed to a new owner, while this never changes and is never
     * reissued. So the address is how somebody is recognised the first time and
     * this is how they are recognised afterwards - which is what stops a
     * changed address locking a person out, and stops a reassigned one
     * inheriting their account.
     */
    googleSubject: text('google_subject'),
    /**
     * When somebody's access was taken away, or `NULL` for everybody who still
     * has it ("Take somebody's access away without taking their work", issue
     * 233).
     *
     * **Absent means enabled**, which is what lets the column arrive without a
     * backfill: every row that predates it has access, and a register that has
     * never disabled anybody is one where this is `NULL` throughout.
     *
     * **No CHECK on it, unlike every other time here.** Adding one to a table
     * that exists rebuilds it in SQLite, which is the manoeuvre that nearly
     * emptied the register once ("Make the database enforce the schema
     * conventions, not just the callers", issue 69) - and the same reason
     * `email` and `google_subject` arrived without constraints (migration
     * 0010). What is written here is one function's `toISOString()`, and what
     * is read is only whether it is there.
     */
    disabledAt: text('disabled_at'),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    check('users_role_is_known', sql.raw(`role IN ('user', 'admin')`)),
    check('users_created_at_is_timestamp', isTimestamp('created_at')),
    // Unique rather than merely indexed: two people sharing an address would be
    // an ambiguous sign-in, and two sharing a Google identity is the same
    // question asked the other way round. SQLite counts NULLs as distinct, so
    // any number of users can be waiting for one.
    //
    // They are created by a migration of their own, after the one that adds the
    // columns, because they are the only statements here that can fail on the
    // data they find - and a file that fails partway is re-run whole by the next
    // deploy, which `ALTER TABLE ADD COLUMN` cannot survive.
    uniqueIndex('users_email').on(table.email),
    uniqueIndex('users_google_subject').on(table.googleSubject),
  ],
);

/**
 * A sign-in that is still current: the cookie's value, whose it is, and when it
 * stops being believed.
 *
 * The row is the authority and the cookie is only a name for it, which is what
 * makes signing out final: the row goes, and the same cookie value afterwards
 * matches nothing. Expiry is stored rather than inferred from `created_at`
 * because it slides - every request that uses a sign-in pushes it out again -
 * so the column is the only thing that knows when it ends.
 *
 * **Nothing sweeps up expired rows, and that is a known gap rather than an
 * oversight.** A sign-in that runs out stops being believed the moment it is
 * next offered - the check is on `expires_at`, not on the row existing - so an
 * old row is dead weight and never a way in. What it costs is one small row per
 * sign-in, forever, in a register with two people in it. Deleting them belongs
 * to a scheduled job, and that is its own piece of work rather than a `DELETE`
 * smuggled into the request path.
 */
export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    createdAt: text('created_at').notNull(),
    expiresAt: text('expires_at').notNull(),
  },
  (table) => [
    index('sessions_user').on(table.userId),
    check('sessions_created_at_is_timestamp', isTimestamp('created_at')),
    check('sessions_expires_at_is_timestamp', isTimestamp('expires_at')),
  ],
);
