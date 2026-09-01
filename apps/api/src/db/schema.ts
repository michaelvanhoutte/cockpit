import { check, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

/**
 * The register, in D1: which accounts exist, and nothing else. An account's own
 * data - its workspaces, dashboards, items, associations and change log - lives
 * in that
 * account's store (src/accounts/schema.ts), never here.
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
