import { beforeEach, describe, expect, inject, it } from 'vitest';
import { SELF, applyD1Migrations, env } from 'cloudflare:test';
import type { Dashboard } from '@cockpit/shared';
import { WORKSPACE_ID, inTheStore, seedRegister, startFromEmpty } from '../seed.js';

/**
 * Integration level, through the real Worker (`SELF.fetch`), because every rule
 * below is about what a query returns or what an index refuses - none of it
 * holds anywhere but against a real store. Which names count as the same name
 * is a pure decision and is settled in apps/api/tests/unit/domain/names.test.ts;
 * what is asked here is the scope that folding is applied in, which only a
 * database can answer.
 *
 * What these cases write survives into the next one, so every case names its
 * own dashboard - `aName()` - rather than reusing a fixed one.
 */

let seq = 0;
function nextId(): string {
  seq += 1;
  return `018f0000-0000-7000-8000-${String(seq).padStart(12, '0')}`;
}
function aName(): string {
  seq += 1;
  return `Research ${seq}`;
}

async function addDashboard(
  workspaceId: string,
  name: string,
  overrides: { commandId?: string; dashboardId?: string } = {},
) {
  return SELF.fetch('http://cockpit.test/v1/commands/add_dashboard', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      commandId: overrides.commandId ?? nextId(),
      issuedAt: '2026-09-01T10:00:00.000Z',
      workspaceId,
      dashboardId: overrides.dashboardId ?? nextId(),
      name,
    }),
  });
}

async function makeWorkspace(name: string): Promise<string> {
  const workspaceId = nextId();
  await SELF.fetch('http://cockpit.test/v1/commands/create_workspace', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      commandId: nextId(),
      issuedAt: '2026-09-01T10:00:00.000Z',
      workspaceId,
      name,
    }),
  });
  return workspaceId;
}

async function renameDashboard(
  workspaceId: string,
  dashboardId: string,
  name: string,
  overrides: { commandId?: string } = {},
) {
  return SELF.fetch('http://cockpit.test/v1/commands/rename_dashboard', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      commandId: overrides.commandId ?? nextId(),
      issuedAt: '2026-09-01T10:00:00.000Z',
      workspaceId,
      dashboardId,
      name,
    }),
  });
}

async function deleteDashboard(
  workspaceId: string,
  dashboardId: string,
  overrides: { commandId?: string } = {},
) {
  return SELF.fetch('http://cockpit.test/v1/commands/delete_dashboard', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      commandId: overrides.commandId ?? nextId(),
      issuedAt: '2026-09-01T10:00:00.000Z',
      workspaceId,
      dashboardId,
    }),
  });
}

/** A dashboard of this workspace, made for the case about to change it. */
async function aDashboardIn(workspaceId: string, name = aName()): Promise<string> {
  const dashboardId = nextId();
  const response = await addDashboard(workspaceId, name, { dashboardId });
  if (response.status !== 200) throw new Error(`could not add a dashboard: ${response.status}`);
  return dashboardId;
}

/** The dashboards of a workspace, as the snapshot answers them. */
async function dashboardsOf(workspaceId: string): Promise<Dashboard[]> {
  const res = await SELF.fetch(`http://cockpit.test/v1/workspaces/${workspaceId}/snapshot`);
  const body = (await res.json()) as { dashboards: Dashboard[] };
  return body.dashboards;
}

async function namesOf(workspaceId: string): Promise<string[]> {
  return (await dashboardsOf(workspaceId)).map((d) => d.name);
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
});

describe('Dashboards', () => {
  describe('a dashboard exists as soon as you add it, and its workspace shows it', () => {
    it('is one of the workspace’s dashboards', async () => {
      const name = aName();

      const response = await addDashboard(WORKSPACE_ID, name);

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, applied: true });
      expect(await namesOf(WORKSPACE_ID)).toContain(name);
    });

    it('is not one of another workspace’s', async () => {
      const elsewhere = await makeWorkspace(aName());
      const before = await namesOf(elsewhere);

      await addDashboard(WORKSPACE_ID, aName());

      expect(await namesOf(elsewhere)).toEqual(before);
    });
  });

  describe('a dashboard’s name is what you typed with the blanks removed, and no two in one workspace share one', () => {
    it('stores the name without the blanks around it', async () => {
      const name = aName();

      await addDashboard(WORKSPACE_ID, `  ${name}  `);

      expect(await namesOf(WORKSPACE_ID)).toContain(name);
    });

    it.each([
      { situation: 'a name this workspace already uses', typed: (n: string) => n, refusal: 409 },
      {
        situation: 'the same name in another case',
        typed: (n: string) => n.toUpperCase(),
        refusal: 409,
      },
      {
        situation: 'a name that only collides once trimmed',
        typed: (n: string) => ` ${n}`,
        refusal: 409,
      },
      { situation: 'no name at all', typed: () => '', refusal: 400 },
      { situation: 'a name of nothing but blanks', typed: () => '   ', refusal: 400 },
      { situation: 'a name too long to read in the bar', typed: () => 'R'.repeat(61), refusal: 400 },
      {
        situation: 'a name broken over two lines',
        typed: (n: string) => `${n}\nand more`,
        refusal: 400,
      },
    ])('refuses $situation, and stores nothing', async ({ typed, refusal }) => {
      const taken = aName();
      await addDashboard(WORKSPACE_ID, taken);
      const before = await namesOf(WORKSPACE_ID);

      const response = await addDashboard(WORKSPACE_ID, typed(taken));

      expect(response.status).toBe(refusal);
      expect(await namesOf(WORKSPACE_ID)).toEqual(before);
    });

    it('refuses a name differing only in a case SQL cannot fold, and says which dashboard has it', async () => {
      // The whole reason the fold is done in the application: SQLite's
      // `lower()` folds A-Z and nothing else, so these two would be two
      // dashboards nobody could tell apart in the bar.
      seq += 1;
      const taken = `ÉTÉ ${seq}`;
      await addDashboard(WORKSPACE_ID, taken);

      const response = await addDashboard(WORKSPACE_ID, taken.toLowerCase());

      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        error: `a dashboard called ${taken} already exists in this workspace`,
      });
    });

    it('allows the same name in another workspace', async () => {
      // The scope is the workspace, not the account: two workspaces may each
      // have a Research and neither knows about the other's.
      const shared = aName();
      const elsewhere = await makeWorkspace(aName());
      await addDashboard(WORKSPACE_ID, shared);

      expect((await addDashboard(elsewhere, shared)).status).toBe(200);
      expect(await namesOf(elsewhere)).toContain(shared);
    });
  });

  describe('a dashboard name comes back exactly as it was typed', () => {
    it('keeps the ampersand, the accent and the emoji', async () => {
      seq += 1;
      const name = `Research & Development 📊 ${seq}`;

      await addDashboard(WORKSPACE_ID, name);

      expect(await namesOf(WORKSPACE_ID)).toContain(name);
    });
  });

  describe('every workspace has a dashboard, whether or not anyone made one', () => {
    it('gives the workspaces an account starts with one each, named Dashboard 1', async () => {
      // The three an account starts with predate dashboards entirely, so this
      // is the backfill's own work rather than anything a create did.
      for (const workspaceId of ['ws-work', 'ws-atlas', 'ws-personal']) {
        expect(await namesOf(workspaceId)).toEqual(['Dashboard 1']);
      }
    });

    it('gives a workspace made afterwards one too', async () => {
      const workspaceId = await makeWorkspace(aName());

      expect(await namesOf(workspaceId)).toEqual(['Dashboard 1']);
    });

    it('gives a deleted workspace one, so restoring it by hand finds it whole', async () => {
      const rows = await inTheStore((sql) =>
        sql
          .exec(
            `SELECT w.id AS id, count(d.id) AS boards
               FROM workspaces w LEFT JOIN dashboards d ON d.workspace_id = w.id
              WHERE w.deleted_at IS NOT NULL GROUP BY w.id`,
          )
          .toArray(),
      );
      // Nothing is deleted in a fresh account, so this is arranged rather than
      // found: tombstone one, and ask again.
      expect(rows).toEqual([]);
      await SELF.fetch('http://cockpit.test/v1/commands/delete_workspace', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          commandId: nextId(),
          issuedAt: '2026-09-01T10:00:00.000Z',
          workspaceId: 'ws-atlas',
        }),
      });

      const afterwards = await inTheStore((sql) =>
        sql
          .exec('SELECT count(*) AS boards FROM dashboards WHERE workspace_id = ?', 'ws-atlas')
          .toArray(),
      );
      expect(afterwards).toEqual([{ boards: 1 }]);
    });
  });

  describe('a dashboard added to a workspace that is not there is refused and nothing is stored', () => {
    it('answers that the workspace is missing, and logs no change', async () => {
      // A validly-shaped id no workspace was ever made with, so it clears
      // request validation and reaches the check for the workspace itself.
      const requestId = nextId();

      const response = await addDashboard('018f0000-0000-7000-8000-999999999999', aName(), {
        commandId: requestId,
      });

      expect(response.status).toBe(404);
      const logged = await inTheStore((sql) =>
        sql.exec('SELECT command_id FROM commands WHERE command_id = ?', requestId).toArray(),
      );
      expect(logged).toEqual([]);
    });
  });

  describe('the same add sent twice adds one dashboard', () => {
    it('does nothing the second time an add arrives twice', async () => {
      // The same request id, which is what an add queued offline and sent again
      // looks like when the first one did land.
      const name = aName();
      const requestId = nextId();
      const dashboardId = nextId();

      expect((await addDashboard(WORKSPACE_ID, name, { commandId: requestId, dashboardId })).status).toBe(200);
      const replay = await addDashboard(WORKSPACE_ID, name, { commandId: requestId, dashboardId });

      expect(replay.status).toBe(200);
      expect(await replay.json()).toEqual({ ok: true, applied: false });
      expect((await namesOf(WORKSPACE_ID)).filter((n) => n === name)).toHaveLength(1);
    });

    it('refuses a second add of the same name, and keeps the first', async () => {
      // Two separate attempts, not a replay: the second carries its own request
      // id and its own dashboard id, so only the name is shared.
      const name = aName();

      expect((await addDashboard(WORKSPACE_ID, name)).status).toBe(200);
      expect((await addDashboard(WORKSPACE_ID, name)).status).toBe(409);

      expect((await namesOf(WORKSPACE_ID)).filter((n) => n === name)).toHaveLength(1);
    });
  });
  describe('renaming a dashboard obeys the rules adding one does', () => {
    it.each([
      {
        situation: 'a name this workspace already uses',
        typed: (taken: string) => taken,
        refusal: 409,
      },
      // Cleaned before it is checked, not after: uniqueness is decided on the
      // trimmed and folded copy, not on what was typed.
      {
        situation: 'a name that only collides once trimmed',
        typed: (taken: string) => `  ${taken} `,
        refusal: 409,
      },
      {
        situation: 'the same name in another case',
        typed: (taken: string) => taken.toUpperCase(),
        refusal: 409,
      },
      { situation: 'no name at all', typed: () => '   ', refusal: 400 },
      {
        situation: 'a name broken over two lines',
        typed: (taken: string) => `${taken}\nand more`,
        refusal: 400,
      },
    ])('refuses a rename to $situation, and leaves the name alone', async ({ typed, refusal }) => {
      const taken = aName();
      await aDashboardIn(WORKSPACE_ID, taken);
      const own = aName();
      const dashboardId = await aDashboardIn(WORKSPACE_ID, own);

      const response = await renameDashboard(WORKSPACE_ID, dashboardId, typed(taken));

      expect(response.status).toBe(refusal);
      expect(await namesOf(WORKSPACE_ID)).toContain(own);
    });

    it.each([
      {
        situation: 'renamed to something else entirely',
        typed: (own: string) => `${own} renamed`,
        shows: (own: string) => `${own} renamed`,
      },
      // The row it folds onto is itself. A check that forgot to leave the
      // dashboard out of its own comparison refuses this, which is the bug this
      // case is here to catch.
      {
        situation: 'renamed to its own name in another case',
        typed: (own: string) => own.toUpperCase(),
        shows: (own: string) => own.toUpperCase(),
      },
      {
        situation: 'renamed to the name it already has',
        typed: (own: string) => own,
        shows: (own: string) => own,
      },
      {
        situation: 'renamed with blanks around it',
        typed: (own: string) => `  ${own} again  `,
        shows: (own: string) => `${own} again`,
      },
    ])('$situation, and that is what shows', async ({ typed, shows }) => {
      const own = aName();
      const dashboardId = await aDashboardIn(WORKSPACE_ID, own);

      const response = await renameDashboard(WORKSPACE_ID, dashboardId, typed(own));

      expect(response.status).toBe(200);
      expect((await dashboardsOf(WORKSPACE_ID)).find((d) => d.id === dashboardId)?.name).toBe(
        shows(own),
      );
    });

    it('takes a name another workspace is using', async () => {
      const shared = aName();
      const elsewhere = await makeWorkspace(aName());
      await aDashboardIn(elsewhere, shared);
      const dashboardId = await aDashboardIn(WORKSPACE_ID);

      expect((await renameDashboard(WORKSPACE_ID, dashboardId, shared)).status).toBe(200);
    });

    it('renames the dashboard a workspace was given, whose id it did not generate', async () => {
      // Every workspace's first dashboard has an id derived from the
      // workspace's own, so asking for the shape of a generated one would
      // refuse to rename exactly the dashboards nobody made by hand.
      const response = await renameDashboard(WORKSPACE_ID, `${WORKSPACE_ID}-dashboard-1`, aName());

      expect(response.status).toBe(200);
    });

    it('takes the name of a dashboard that is not there any more', async () => {
      const gone = aName();
      const goneId = await aDashboardIn(WORKSPACE_ID, gone);
      await deleteDashboard(WORKSPACE_ID, goneId);
      const dashboardId = await aDashboardIn(WORKSPACE_ID);

      expect((await renameDashboard(WORKSPACE_ID, dashboardId, gone)).status).toBe(200);
    });
  });

  describe('a deleted dashboard is gone from everywhere you can reach it', () => {
    it('is not one of the workspace’s dashboards', async () => {
      const dashboardId = await aDashboardIn(WORKSPACE_ID);

      expect((await deleteDashboard(WORKSPACE_ID, dashboardId)).status).toBe(200);

      expect((await dashboardsOf(WORKSPACE_ID)).map((d) => d.id)).not.toContain(dashboardId);
    });

    it('leaves another workspace’s dashboards alone', async () => {
      const elsewhere = await makeWorkspace(aName());
      await aDashboardIn(elsewhere);
      const before = await namesOf(elsewhere);
      const dashboardId = await aDashboardIn(WORKSPACE_ID);

      await deleteDashboard(WORKSPACE_ID, dashboardId);

      expect(await namesOf(elsewhere)).toEqual(before);
    });

    it('gives its name back to the workspace', async () => {
      const name = aName();
      const dashboardId = await aDashboardIn(WORKSPACE_ID, name);
      await deleteDashboard(WORKSPACE_ID, dashboardId);

      expect((await addDashboard(WORKSPACE_ID, name)).status).toBe(200);
    });
  });

  describe('a workspace always has a dashboard left', () => {
    it('lets one of several go', async () => {
      const workspaceId = await makeWorkspace(aName());
      const dashboardId = await aDashboardIn(workspaceId);

      expect((await deleteDashboard(workspaceId, dashboardId)).status).toBe(200);
      expect(await namesOf(workspaceId)).toEqual(['Dashboard 1']);
    });

    it('refuses the last one, and says why', async () => {
      // The one delete Cockpit refuses: a workspace with no dashboards has no
      // view at all.
      const workspaceId = await makeWorkspace(aName());
      const [only] = await dashboardsOf(workspaceId);

      const response = await deleteDashboard(workspaceId, only!.id);

      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: 'a workspace keeps at least one dashboard' });
      expect(await namesOf(workspaceId)).toEqual(['Dashboard 1']);
    });
  });

  describe('a change to a dashboard that is not there is refused and nothing is stored', () => {
    // A validly-shaped id no dashboard was ever made with, so it clears request
    // validation and reaches the check for the dashboard itself.
    const goneDashboardId = '018f0000-0000-7000-8000-777777777777';

    it.each([
      { situation: 'renaming it', name: 'rename_dashboard' as const, extra: { name: 'Anything' } },
      { situation: 'deleting it', name: 'delete_dashboard' as const, extra: {} },
    ])('$situation', async ({ name, extra }) => {
      const requestId = nextId();

      const response = await SELF.fetch(`http://cockpit.test/v1/commands/${name}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          commandId: requestId,
          issuedAt: '2026-09-01T10:00:00.000Z',
          workspaceId: WORKSPACE_ID,
          dashboardId: goneDashboardId,
          ...extra,
        }),
      });

      expect(response.status).toBe(404);
      const logged = await inTheStore((sql) =>
        sql.exec('SELECT command_id FROM commands WHERE command_id = ?', requestId).toArray(),
      );
      expect(logged).toEqual([]);
    });
  });

  describe('the same delete sent twice deletes one dashboard', () => {
    it('does nothing the second time a delete arrives twice', async () => {
      // The same request id, which is what a delete queued offline and sent
      // again looks like when the first one did land.
      const dashboardId = await aDashboardIn(WORKSPACE_ID);
      const requestId = nextId();

      expect(
        (await deleteDashboard(WORKSPACE_ID, dashboardId, { commandId: requestId })).status,
      ).toBe(200);
      const replay = await deleteDashboard(WORKSPACE_ID, dashboardId, { commandId: requestId });

      expect(replay.status).toBe(200);
      expect(await replay.json()).toEqual({ ok: true, applied: false });
    });

    it('refuses a second delete of a dashboard already gone, and moves nothing', async () => {
      const dashboardId = await aDashboardIn(WORKSPACE_ID);
      await deleteDashboard(WORKSPACE_ID, dashboardId);
      const [deleted] = await inTheStore((sql) =>
        sql
          .exec<{ deleted_at: string }>('SELECT deleted_at FROM dashboards WHERE id = ?', dashboardId)
          .toArray(),
      );

      const again = await deleteDashboard(WORKSPACE_ID, dashboardId);

      expect(again.status).toBe(404);
      const [after] = await inTheStore((sql) =>
        sql
          .exec<{ deleted_at: string }>('SELECT deleted_at FROM dashboards WHERE id = ?', dashboardId)
          .toArray(),
      );
      // When it was deleted stays what it was, rather than being moved by a
      // second attempt long afterwards.
      expect(after?.deleted_at).toBe(deleted?.deleted_at);
    });
  });
});
