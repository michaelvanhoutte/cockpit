import { check, index, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

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
 * **`role` is carried and never enforced**, deliberately ("Sign in by picking a
 * name, each user in their own account", issue 86). There is no admin-only page
 * to guard yet, so there is nothing to test a gate against; putting the column
 * in now is what stops role logic being retrofitted through every query later.
 * The first admin-only page brings the check and the first test of it.
 *
 * **There is no secret on a user, and that is the current stage rather than an
 * oversight.** A passwordless list of names is an identity selector, not an
 * authentication control - which is why Cloudflare Access stays in front of
 * every deployed environment (docs/architecture.md, "App login"). When Google
 * sign-in lands it adds the columns it needs here; nothing else moves.
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
    role: text('role').notNull(),
    createdAt: text('created_at').notNull(),
  },
  () => [
    check('users_role_is_known', sql.raw(`role IN ('user', 'admin')`)),
    check('users_created_at_is_timestamp', isTimestamp('created_at')),
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
