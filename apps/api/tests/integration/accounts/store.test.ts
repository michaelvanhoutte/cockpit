import { beforeEach, describe, expect, inject, it } from 'vitest';
import { applyD1Migrations, env } from 'cloudflare:test';
import { asUser, inTheStoreAsItIs, seedRegister, startFromEmpty } from '../seed.js';

/**
 * Integration level, through the real Worker: what these cases are about is
 * that an account is resolved on the real request path - who is signed in,
 * then the register, then that account's own store - and none of that exists
 * below the HTTP entry point ("Enter through the real interface, not around
 * it").
 *
 * The branching in bringing an account up to date is *not* re-proved here. It
 * is decided by a list, a record and an executor with nothing real behind them,
 * and it is proved at apps/api/tests/unit/accounts/up-to-date.test.ts. The one
 * case below that touches it asks the question that file cannot: whether the
 * rollback is real against actual storage.
 */

async function fetchWorkspaces() {
  return asUser('http://cockpit.test/v1/workspaces');
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
});

describe('Accounts', () => {
  describe('an account’s data is reached only through that account, and one that is not in the register is an error', () => {
    it('answers with the workspaces the account starts with', async () => {
      await seedRegister();

      const response = await fetchWorkspaces();

      expect(response.status).toBe(200);
      const { workspaces } = (await response.json()) as { workspaces: { name: string }[] };
      expect(workspaces.map((w) => w.name)).toEqual(['Work', 'Atlas Copco', 'Personal']);
    });

    /**
     * There is deliberately no case here for an account that is absent from the
     * register, and it is gone rather than forgotten.
     *
     * The account a request resolves is now the one belonging to whoever signed
     * in, and a user's account is a foreign key into the register - so a signed-in
     * request naming an unregistered account is a state the database refuses to
     * hold. It cannot be arranged through the interface, and a test that reached
     * around the interface to arrange it would be proving something about a
     * database no deployment can be in. What replaces it is the constraint that
     * makes it impossible, in tests/integration/db/constraints.test.ts.
     *
     * `openAccount` still checks the register, and the check is worth keeping:
     * addressing a store by name creates one, so the register is what turns a
     * name nobody owns into an error rather than an empty account. It is now
     * defence behind the foreign key rather than the only thing standing there.
     */

    it('never answers with a workspace filed under another account', async () => {
      await seedRegister();
      // Opens the account, so its tables exist to write the intruder into.
      await fetchWorkspaces();
      await inTheStoreAsItIs((sql) => {
        sql.exec(
          `INSERT INTO workspaces (id, tenant_id, name, folded_name, color, created_at)
           VALUES ('ws-somebody-else', 'another-account', 'Theirs', 'theirs', '#000000', '2026-08-12T00:00:04.000Z')`,
        );
      });

      const { workspaces } = (await (await fetchWorkspaces()).json()) as {
        workspaces: { name: string }[];
      };

      // The column is redundant now that the store *is* the account, and this
      // is what it is for: a request that reached the wrong data matches no row
      // instead of answering with somebody else's.
      expect(workspaces.map((w) => w.name)).not.toContain('Theirs');
    });
  });

  describe('a change that cannot be applied says which change failed and why', () => {
    it('refuses the request and leaves nothing of that change behind', async () => {
      await seedRegister();
      // One of the tables the first change creates is already there, so that
      // change fails partway - after three tables have been created inside the
      // same transaction and before it is recorded as applied.
      await inTheStoreAsItIs((sql) => {
        sql.exec('CREATE TABLE commands (whatever text)');
      });

      const response = await fetchWorkspaces();

      expect(response.status).toBe(500);
      const { error } = (await response.json()) as { error: string };
      expect(error).toContain('0001-account-schema');
      expect(error).toContain('commands');

      const tables = await inTheStoreAsItIs((sql) =>
        sql
          .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
          .toArray()
          .map((row) => row.name),
      );
      expect(tables).not.toContain('workspaces');
      expect(tables).not.toContain('items');
      expect(tables).not.toContain('associations');
    });
  });
});
