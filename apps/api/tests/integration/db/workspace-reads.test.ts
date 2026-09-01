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
 * puts it in the same position for as long as the rollback lasts. This is the
 * guarantee the migration that drops `slug` rests on, one release from now
 * ("Drop the unused workspace slug column", issue 78).
 *
 * **Why it asserts the whole workspace rather than just a status.** Losing a
 * column a query names does not fail the way you would expect, and this is the
 * measurement that settles it. SQLite reads a double-quoted identifier that
 * matches no column as a *string literal*, and drizzle quotes every identifier
 * it emits - so `select ..., "slug", ... from workspaces` against a table
 * without that column returns the text `slug` for every row instead of
 * refusing. Measured against a real D1, both halves: the double-quoted form
 * comes back as `slug`, the bare `select slug` raises "no such column".
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
  // The state the next release's migration leaves for this one to run against.
  await env.DB.prepare('ALTER TABLE workspaces DROP COLUMN slug').run();
});

describe('Workspace management', () => {
  describe('a workspace survives a column it is not made of being taken away', () => {
    it('comes back as itself, with nothing invented', async () => {
      const response = await SELF.fetch('http://cockpit.test/v1/workspaces');

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        workspaces: [{ id: WORKSPACE_ID, tenantId: TENANT_ID, name: 'Work', color: '#6f62b5' }],
      });
    });
  });
});
