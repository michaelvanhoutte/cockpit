import { beforeAll, describe, expect, inject, it } from 'vitest';
import { env, applyD1Migrations, SELF } from 'cloudflare:test';
import { TENANT_ID, WORKSPACE_ID, seedWorkspaces } from '../seed.js';

/**
 * Integration level, and it could be nothing else: what is under test is the
 * SQL that actually reaches the database, and the only way to ask which columns
 * it names is to take one away and see what comes back.
 *
 * Its own file because it arranges a database no other test wants - one with a
 * column missing - and because what it asks about is the shape of a deploy
 * rather than a feature. Every deploy applies migrations *before* the new code
 * goes live, so for those seconds the release running is the previous one,
 * against a table the next one has already changed; promoting an earlier commit
 * puts it in the same position for as long as the rollback lasts. Keeping the
 * reads down to the columns they need is what makes that survivable, and this
 * is what says they still are.
 *
 * It dropped `slug` until migration 0006 removed that column for good. Now it
 * drops `folded_name`, which is the remaining column the table carries and no
 * query reads - only the unique index does, which is why that index has to go
 * first. Same question, and it will keep being answerable as long as there is
 * one such column; the day there is not, this file goes rather than being
 * pointed at a column something reads.
 *
 * **Why it asserts the whole workspace rather than just a status.** Losing a
 * column a query names does not fail the way you would expect, and this is the
 * measurement that settles it. SQLite reads a double-quoted identifier that
 * matches no column as a *string literal*, and drizzle quotes every identifier
 * it emits - so `select ..., "folded_name", ... from workspaces` against a
 * table without that column returns the text `folded_name` for every row
 * instead of refusing. Measured against a real D1, both halves: the
 * double-quoted form comes back as the column's own name, the bare
 * `select folded_name` raises "no such column".
 *
 * So a status code proves nothing here - the request answers 200 either way -
 * and only the body shows the difference: a workspace carrying fields it should
 * not have, one of them invented. That is also why the read paths name their
 * columns rather than taking all of them (`workspaceColumns` in src/db/repo.ts):
 * the alternative works today by accident of a misfeature, and would stop
 * working the day D1 turns it off.
 *
 * `beforeAll` and one case, because the arrangement is destructive and this
 * pool's storage carries from one case into the next: a second case would find
 * the column already gone and its own seeding would fail on it.
 */
beforeAll(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await seedWorkspaces();
  // SQLite refuses to drop a column an index refers to, and this column's only
  // reader is that index.
  await env.DB.prepare('DROP INDEX IF EXISTS workspaces_tenant_live_folded_name').run();
  await env.DB.prepare('ALTER TABLE workspaces DROP COLUMN folded_name').run();
});

describe('Workspace management', () => {
  describe('a workspace survives a column it is not made of being taken away', () => {
    it('comes back as itself, with nothing invented', async () => {
      const response = await SELF.fetch('http://cockpit.test/v1/workspaces');

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        workspaces: [
          {
            id: WORKSPACE_ID,
            tenantId: TENANT_ID,
            name: 'Work',
            color: '#6f62b5',
            ground: '#e3e1f2',
            header: '#d2cdea',
          },
        ],
      });
    });
  });
});
