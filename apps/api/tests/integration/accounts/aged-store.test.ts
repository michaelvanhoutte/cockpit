import { beforeEach, describe, expect, inject, it } from 'vitest';
import { applyD1Migrations, env } from 'cloudflare:test';
import { accountChanges } from '../../../src/accounts/changes.js';
import { inStoreAsItIs, startFromEmpty, storeNamed } from '../seed.js';

/**
 * The gate that replaced the one D1 used to give for free.
 *
 * While an account's data was in D1, a schema change that could not be applied
 * failed at deploy time: one command, before anything went live, and the deploy
 * stopped. Now each account applies its outstanding updates when somebody next
 * opens it, so a bad one fails inside a request instead - and the proof behind
 * docs/account-storage-options.md measured what that looks like: every account
 * falls over, one at a time as they wake, and the first person to know is a
 * user rather than whoever deployed.
 *
 * This is that gate, and it is a test rather than a script on purpose:
 * .github/workflows/deploy-staging.yml runs `pnpm test` before it deploys, so a
 * red test here already stops the deploy, with no second mechanism to keep in
 * step with this one.
 *
 * **What it adds over the tests that already exist.** Opening an account at all
 * applies every update, so apps/api/tests/integration/accounts/store.test.ts
 * incidentally proves they apply to a *new* store, and the branching in
 * deciding which to apply is proved at apps/api/tests/unit/accounts/up-to-date.test.ts.
 * Neither touches the case that actually breaks: an update that is fine against
 * an empty table and fails against a full one. So every update is applied here
 * to a store that already carries the ones before it and rows in every table
 * they created - which also means an account left untouched across several
 * releases is exercised, since the run starts from every point in the list.
 *
 * **Adding an update means adding to `rowsFor` below** if it creates a table,
 * so that the next update meets a full one rather than an empty one. That is
 * the same discipline as writing the update itself, and it is what keeps this
 * gate from quietly becoming the empty-store test again.
 */

const AT = '2026-08-12T10:00:00.000Z';

/** A store no account owns, one per case, so a broken arrangement cannot leak into the next. */
function fixtureName(index: number): string {
  return `aged-store-fixture-${index}`;
}

/**
 * Puts a store in the state an account is in when it has applied everything up
 * to `applied` and nothing since - recorded as applied, exactly as the store
 * itself records it, so that opening it afterwards has real outstanding work.
 */
async function agedTo(name: string, applied: number): Promise<void> {
  const changes = accountChanges(name);
  await inStoreAsItIs(name, (sql) => {
    sql.exec(
      `CREATE TABLE IF NOT EXISTS account_changes (
         name text PRIMARY KEY NOT NULL,
         applied_at text NOT NULL
       ) STRICT`,
    );
    for (const change of changes.slice(0, applied)) {
      for (const statement of change.statements) {
        sql.exec(statement.sql, ...(statement.params ?? []));
      }
      sql.exec('INSERT INTO account_changes (name, applied_at) VALUES (?, ?)', change.name, AT);
    }
  });
}

/**
 * A row for every table that exists at this point, in the order the foreign
 * keys require. Keyed by table so that a store part-way through the list gets
 * rows in what it has and nothing else.
 */
const rowsFor: { table: string; sql: string; params: (name: string) => string[] }[] = [
  // In foreign-key order, which is why this is a list and not a lookup.
  {
    table: 'workspaces',
    // Every column named out loud, defaults included: this row is here to be
    // what the *next* update meets, so it should be a whole workspace rather
    // than the subset that happens to have no default today.
    sql: `INSERT INTO workspaces (id, tenant_id, name, folded_name, color, ground, header, created_at)
          VALUES ('ws-before', ?, 'Before', 'before', '#6f62b5', '#e3e1f2', '#d2cdea', ?)`,
    params: (name) => [name, AT],
  },
  {
    table: 'items',
    sql: `INSERT INTO items (id, tenant_id, workspace_id, source, title, status, unseen, created_at, updated_at)
          VALUES ('it-before', ?, 'ws-before', 'internal', 'Captured before the update', 'task', 0, ?, ?)`,
    params: (name) => [name, AT, AT],
  },
  {
    table: 'associations',
    sql: `INSERT INTO associations (id, tenant_id, item_id, kind, label, created_at)
          VALUES ('as-before', ?, 'it-before', 'person', 'Anna', ?)`,
    params: (name) => [name, AT],
  },
  {
    table: 'commands',
    sql: `INSERT INTO commands (command_id, tenant_id, workspace_id, name, payload, issued_at, received_at)
          VALUES ('cmd-before', ?, 'ws-before', 'capture_item', '{}', ?, ?)`,
    params: (name) => [name, AT, AT],
  },
];

/** Fills every table the store has, so the outstanding updates meet data rather than emptiness. */
async function fillWithWhatIsAlreadyThere(name: string): Promise<void> {
  await inStoreAsItIs(name, (sql) => {
    const tables = new Set(
      sql
        .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
        .toArray()
        .map((row) => row.name),
    );
    for (const row of rowsFor) {
      if (tables.has(row.table)) sql.exec(row.sql, ...row.params(name));
    }
  });
}

/**
 * Every point an account can be sitting at with real work still outstanding.
 * Point 0 is left out deliberately: a store with nothing applied is a new one,
 * and store.test.ts already opens one of those.
 */
const updates = accountChanges('any-account-would-do');
const points = updates
  .map((_, applied) => ({ applied, position: applied + 1, total: updates.length }))
  .filter(({ applied }) => applied > 0);

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
});

describe('Accounts', () => {
  describe('every update applies to an account that already has data, not only to a new one', () => {
    it.each(points)(
      'applies update $position of $total, and what was already captured is still there',
      async ({ applied }) => {
        const name = fixtureName(applied);
        await agedTo(name, applied);
        await fillWithWhatIsAlreadyThere(name);

        // Opening the store is what brings it up to date, exactly as the first
        // request of the day does for a real account.
        const answer = await storeNamed(name).workspaces(name);

        expect(answer).toMatchObject({ status: 'ok' });
        expect(
          await inStoreAsItIs(name, (sql) =>
            sql.exec("SELECT title FROM items WHERE id = 'it-before'").toArray(),
          ),
        ).toEqual([{ title: 'Captured before the update' }]);
      },
    );
  });
});
