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
 * Integration level, because what is claimed here is what happens *between* a
 * real register and a real account. What a request has to be to reach this at
 * all is settled in tests/integration/http/user-management.test.ts and is not
 * re-proved.
 *
 * `deleteUser` is called directly for the one case that has to control the
 * moment in the middle, which nothing on the request path can reach. The rest
 * go through the endpoint, as everything else does.
 */

/** What that account holds, read as it stands - so asking creates nothing. */
function tablesIn(accountName: string): Promise<string[]> {
  return inStoreAsItIs(accountName, (sql) => [
    ...sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'"),
  ]).then((rows) => rows.map((row) => row.name));
}

/** Somebody's work in their account, written straight in - how it got there is not the claim. */
function putSomethingIn(accountName: string, whose: string): Promise<unknown> {
  return inStoreAsItIs(accountName, (sql) => {
    sql.exec('CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, tenant_id TEXT)');
    sql.exec("INSERT INTO workspaces (id, tenant_id) VALUES ('ws-theirs', ?)", whose);
  });
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
});

describe('User management', () => {
  describe('nothing in flight while somebody was deleted leaves their account behind', () => {
    /**
     * The window this narrows: between emptying the account and taking the
     * register rows, a request already past the gate - an open event stream, a
     * command mid-flight - still holds the account, and its next touch brings it
     * up to date, which makes its tables afresh. That account would then be
     * waiting under a name the register is free to hand out again.
     */
    it('empties the account again once the register can no longer be asked for it', async () => {
      let touchedAfterTheFirstPass = false;
      const emptyAndThenSomething = async (accountId: string) => {
        await destroyAccountStore(env, accountId);
        if (touchedAfterTheFirstPass) return;
        touchedAfterTheFirstPass = true;
        // Somebody's request, still holding the account, writing to it - which
        // is what bringing an account up to date does.
        await putSomethingIn(accountId, accountId);
      };

      const gone = await deleteUser(env, OTHER_USER_ID, USER_ID, emptyAndThenSomething);

      expect(gone).toEqual({ deleted: true });
      expect(await tablesIn(OTHER_ACCOUNT_NAME)).toEqual([]);
    });
  });

  /**
   * `tenant_id` is the second lock the architecture leans on, and emptying an
   * account is the one operation with nothing to undo it. A lock nothing ever
   * tries is one nobody would notice had broken.
   */
  describe('an account holding somebody else’s work is not emptied', () => {
    beforeEach(() => putSomethingIn(OTHER_ACCOUNT_NAME, ACCOUNT_NAME));

    it('refuses, naming whose the work is', async () => {
      await expect(destroyAccountStore(env, OTHER_ACCOUNT_NAME)).rejects.toThrow(
        new RegExp(`${OTHER_ACCOUNT_NAME} was not destroyed.+${ACCOUNT_NAME}`),
      );

      expect(await tablesIn(OTHER_ACCOUNT_NAME)).toContain('workspaces');
    });
  });
});
