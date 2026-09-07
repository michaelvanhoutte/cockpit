import { beforeEach, describe, expect, inject, it } from 'vitest';
import { applyD1Migrations, env } from 'cloudflare:test';
import { deleteUser } from '../../../src/accounts/register.js';
import { destroyAccountStore } from '../../../src/accounts/index.js';
import {
  ACCOUNT_NAME,
  OTHER_ACCOUNT_NAME,
  OTHER_USER_ID,
  USER_ID,
  inStoreAsItIs,
  seedRegister,
  startFromEmpty,
} from '../seed.js';

/**
 * Integration level, because both of these are about a real store and a real
 * register at once, and the thing being claimed is what happens *between* them.
 * What a request has to be to reach here at all is settled by the cases in
 * tests/integration/http/user-management.test.ts and is not re-proved.
 *
 * `deleteUser` is called directly rather than through the endpoint, because
 * what these cases have to control is the moment in the middle - which nothing
 * on the request path can reach.
 */

/** Which tables the store has, read as it stands so asking creates nothing. */
function tablesIn(accountName: string): Promise<string[]> {
  return inStoreAsItIs(accountName, (sql) => [
    ...sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'"),
  ]).then((rows) => rows.map((row) => row.name));
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
});

describe('User management', () => {
  describe('nothing that was in flight while it was deleted leaves the account behind', () => {
    /**
     * The window this closes: between destroying the store and taking the
     * register rows, a request already past the gate - an open event stream, a
     * command mid-flight - still holds the store, and its next touch brings the
     * account up to date, which creates its tables afresh. That store would then
     * be waiting under a name the register is free to hand out again, which is
     * the whole failure this issue exists to prevent.
     */
    it('destroys the store again once the register can no longer be asked for it', async () => {
      let touchedAfterTheFirstDestroy = false;
      const destroyAndThenSomething = async (accountId: string) => {
        await destroyAccountStore(env, accountId);
        if (touchedAfterTheFirstDestroy) return;
        touchedAfterTheFirstDestroy = true;
        // Somebody's request, still holding the store, writing to it - which is
        // what bringing an account up to date does.
        await inStoreAsItIs(accountId, (sql) => {
          sql.exec('CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, tenant_id TEXT)');
          sql.exec("INSERT INTO workspaces (id, tenant_id) VALUES ('ws-late', ?)", accountId);
        });
      };

      const gone = await deleteUser(env, OTHER_USER_ID, USER_ID, destroyAndThenSomething);

      expect(gone).toEqual({ deleted: true });
      expect(await tablesIn(OTHER_ACCOUNT_NAME)).toEqual([]);
    });
  });

  /**
   * `tenant_id` is the second lock the architecture leans on, and this is the
   * one operation with nothing to undo it. A lock nothing ever tries is one
   * nobody would notice had broken.
   */
  describe('a store holding somebody else’s rows is not destroyed', () => {
    beforeEach(async () => {
      await inStoreAsItIs(OTHER_ACCOUNT_NAME, (sql) => {
        sql.exec('CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, tenant_id TEXT)');
        sql.exec("INSERT INTO workspaces (id, tenant_id) VALUES ('ws-theirs', ?)", ACCOUNT_NAME);
      });
    });

    it('refuses, naming whose the rows are', async () => {
      await expect(destroyAccountStore(env, OTHER_ACCOUNT_NAME)).rejects.toThrow(
        new RegExp(`${OTHER_ACCOUNT_NAME} was not destroyed.+${ACCOUNT_NAME}`),
      );

      expect(await tablesIn(OTHER_ACCOUNT_NAME)).toContain('workspaces');
    });

    /**
     * Stopping there rather than partway: the person is still in the register,
     * so the deletion can be looked at and asked for again.
     */
    it('leaves the person the register holds', async () => {
      await expect(deleteUser(env, OTHER_USER_ID, USER_ID, (id) => destroyAccountStore(env, id))).rejects.toThrow();

      const { results } = await env.DB.prepare('SELECT id FROM users WHERE id = ?')
        .bind(OTHER_USER_ID)
        .all();
      expect(results).toHaveLength(1);
    });
  });
});
