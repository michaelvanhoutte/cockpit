import { beforeAll, describe, expect, inject, it } from 'vitest';
import { env, applyD1Migrations, SELF } from 'cloudflare:test';
import { themeOf } from '@cockpit/shared';
import { ACCOUNT_NAME, asUser, inTheStore, seedRegister, startFromEmpty } from '../seed.js';

/**
 * Integration level, and it could be nothing else: what is under test is the
 * SQL that actually reaches the store, and the only way to ask which columns it
 * names is to take one away and see what comes back.
 *
 * Its own file because it arranges a store no other test wants - one with a
 * column missing - and because what it asks about is the shape of a deploy
 * rather than a feature. An account applies outstanding changes on the first
 * request that opens it, and a rollback leaves the previous release reading a
 * store the next one has already changed. Keeping the reads down to the columns
 * they need is what makes that survivable, and this is what says they still are.
 *
 * It drops `folded_name`, the one column the table carries that no query reads -
 * only the unique index does, which is why that index has to go first. It will
 * keep being answerable as long as there is one such column; the day there is
 * not, this file goes rather than being pointed at a column something reads.
 *
 * **Why it asserts the whole workspace rather than just a status.** Losing a
 * column a query names does not fail the way you would expect, and this is the
 * measurement that settles it. SQLite reads a double-quoted identifier that
 * matches no column as a *string literal*, and drizzle quotes every identifier
 * it emits - so `select ..., "folded_name", ... from workspaces` against a table
 * without that column returns the text `folded_name` for every row instead of
 * refusing. Measured against a real D1, both halves: the double-quoted form
 * comes back as the column's own name, the bare `select folded_name` raises
 * "no such column".
 *
 * So a status code proves nothing here - the request answers 200 either way -
 * and only the body shows the difference: a workspace carrying fields it should
 * not have, one of them invented. That is also why the read paths name their
 * columns rather than taking all of them (`workspaceColumns` in
 * src/accounts/repo.ts): the alternative works today by accident of a
 * misfeature, and would stop working the day SQLite turns it off.
 *
 * `beforeAll` and one case, because the arrangement is destructive: a second
 * case would find the column already gone and its own arrangement would fail on
 * it.
 */
beforeAll(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
  // `inTheStore` opens the account first, so the tables and the workspaces it
  // starts with are there to take a column away from.
  await inTheStore((sql) => {
    // SQLite refuses to drop a column an index refers to, and this column's
    // only reader is that index.
    sql.exec('DROP INDEX IF EXISTS workspaces_tenant_live_folded_name');
    sql.exec('ALTER TABLE workspaces DROP COLUMN folded_name');
  });
});

describe('Workspace management', () => {
  describe('a workspace survives a column it is not made of being taken away', () => {
    it('comes back as itself, with nothing invented', async () => {
      const response = await asUser('http://cockpit.test/v1/workspaces');

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        workspaces: [
          // The colours are read off the palette rather than written out: the
          // three surfaces are repainted by an account's own changes when the
          // palette moves (`accounts/changes.ts`, `0010-workspace-ink`), and a
          // copy of them here would say only that somebody remembered to edit
          // this file.
          { id: 'ws-work', tenantId: ACCOUNT_NAME, name: 'Work', ...wearing('#6f62b5') },
          { id: 'ws-atlas', tenantId: ACCOUNT_NAME, name: 'Atlas Copco', ...wearing('#3a72c8') },
          { id: 'ws-personal', tenantId: ACCOUNT_NAME, name: 'Personal', ...wearing('#c06a45') },
        ],
      });
    });
  });
});

/** A workspace's four colours, in the shape the wire carries them. */
function wearing(tint: string) {
  const theme = themeOf(tint);
  return { color: theme.tint, bar: theme.bar, ground: theme.ground, header: theme.header };
}
