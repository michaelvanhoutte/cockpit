import { beforeEach, describe, expect, inject, it } from 'vitest';
import { SELF, applyD1Migrations, env } from 'cloudflare:test';
import type { Dashboard } from '@cockpit/shared';
import {
  ACCOUNT_NAME,
  WORKSPACE_ID,
  asUser,
  inTheStore,
  seedRegister,
  startFromEmpty,
} from '../seed.js';

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
  return asUser('http://cockpit.test/v1/commands/add_dashboard', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      commandId: overrides.commandId ?? nextId(),
      issuedAt: '2026-09-01T10:00:00.000Z',
      workspaceId,
      dashboardId: overrides.dashboardId ?? nextId(),
      panelId: nextId(),
      name,
    }),
  });
}

async function makeWorkspace(name: string): Promise<string> {
  const workspaceId = nextId();
  await asUser('http://cockpit.test/v1/commands/create_workspace', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      commandId: nextId(),
      issuedAt: '2026-09-01T10:00:00.000Z',
      workspaceId,
      panelId: nextId(),
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
  return asUser('http://cockpit.test/v1/commands/rename_dashboard', {
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
  return asUser('http://cockpit.test/v1/commands/delete_dashboard', {
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

async function reorderDashboards(workspaceId: string, dashboardId: string, dashboardIds: string[]) {
  return asUser('http://cockpit.test/v1/commands/reorder_dashboards', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      commandId: nextId(),
      issuedAt: '2026-09-01T10:00:00.000Z',
      workspaceId,
      dashboardId,
      dashboardIds,
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
  const res = await asUser(`http://cockpit.test/v1/workspaces/${workspaceId}/snapshot`);
  const body = (await res.json()) as { dashboards: Dashboard[] };
  return body.dashboards;
}

async function namesOf(workspaceId: string): Promise<string[]> {
  return (await dashboardsOf(workspaceId)).map((d) => d.name);
}

/** The order the bar would draw, which is what the ordering cases are about. */
async function theOrder(workspaceId: string): Promise<string[]> {
  return (await dashboardsOf(workspaceId)).map((d) => d.id);
}

/** The panels of one dashboard, as the snapshot answers them. */
async function panelsOn(workspaceId: string, dashboardId: string): Promise<string[]> {
  const res = await asUser(`http://cockpit.test/v1/workspaces/${workspaceId}/snapshot`);
  const body = (await res.json()) as { panels: { id: string; dashboardId: string; name: string }[] };
  return body.panels.filter((panel) => panel.dashboardId === dashboardId).map((p) => p.name);
}

/** The one dashboard a workspace arrives with. */
async function theDashboardOf(workspaceId: string): Promise<string> {
  const [only] = await dashboardsOf(workspaceId);
  if (!only) throw new Error(`${workspaceId} has no dashboard`);
  return only.id;
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
    it('gives the workspace an account starts with one, named Dashboard 1', async () => {
      expect(await namesOf(WORKSPACE_ID)).toEqual(['Dashboard 1']);
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
      await asUser('http://cockpit.test/v1/commands/delete_workspace', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          commandId: nextId(),
          issuedAt: '2026-09-01T10:00:00.000Z',
          workspaceId: WORKSPACE_ID,
        }),
      });

      const afterwards = await inTheStore((sql) =>
        sql
          .exec('SELECT count(*) AS boards FROM dashboards WHERE workspace_id = ?', WORKSPACE_ID)
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

      const response = await asUser(`http://cockpit.test/v1/commands/${name}`, {
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

  /**
   * The Inbox holds every open item that no panel holds, so a workspace whose
   * dashboards have no panels has no way to take anything *out* of the Inbox -
   * the drag has no target. Which is why this is about every dashboard rather
   * than only a workspace's first: the `+` in the bar would otherwise make one
   * such dashboard at a time.
   */
  describe('every dashboard arrives with a panel, so there is somewhere to file into', () => {
    it('gives the dashboard an account starts with one, named Panel 1', async () => {
      expect(await panelsOn(WORKSPACE_ID, await theDashboardOf(WORKSPACE_ID))).toEqual(['Panel 1']);
    });

    it('gives the dashboard of a workspace made afterwards one too', async () => {
      const workspaceId = await makeWorkspace(aName());

      expect(await panelsOn(workspaceId, await theDashboardOf(workspaceId))).toEqual(['Panel 1']);
    });

    it('gives a dashboard added to a workspace one', async () => {
      const dashboardId = await aDashboardIn(WORKSPACE_ID);

      expect(await panelsOn(WORKSPACE_ID, dashboardId)).toEqual(['Panel 1']);
    });

    /**
     * **The panel is the one row here whose id is new on every attempt**, and
     * that is what makes this worth two cases rather than one. The workspace's
     * id is the client's and the dashboard's is derived from it, so both are
     * no-ops on a replay whatever request id it carries; the panel's is
     * generated afresh, so a second attempt would be a second Panel 1 - which
     * the title index refuses, taking the whole request down with it rather
     * than answering "already done".
     */
    it.each([
      { situation: 'the same request id, which is caught before the handler', fresh: false },
      { situation: 'a request id that was lost and replaced', fresh: true },
    ])('adds one panel when an add is repeated with $situation', async ({ fresh }) => {
      const dashboardId = nextId();
      const commandId = nextId();
      const first = await addDashboard(WORKSPACE_ID, aName(), { dashboardId, commandId });
      expect(first.status).toBe(200);

      // A different name on the second attempt, so the name check does not
      // answer it first and the insert is really reached.
      const again = await addDashboard(WORKSPACE_ID, aName(), {
        dashboardId,
        ...(fresh ? {} : { commandId }),
      });

      expect(again.status).toBe(200);
      expect(await panelsOn(WORKSPACE_ID, dashboardId)).toEqual(['Panel 1']);
    });

    it('adds one panel when a workspace is made twice with a request id that was lost', async () => {
      const workspaceId = await makeWorkspace(aName());

      const again = await asUser('http://cockpit.test/v1/commands/create_workspace', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          commandId: nextId(),
          issuedAt: '2026-09-01T10:00:00.000Z',
          workspaceId,
          panelId: nextId(),
          name: aName(),
        }),
      });

      expect(again.status).toBe(200);
      expect(await panelsOn(workspaceId, await theDashboardOf(workspaceId))).toEqual(['Panel 1']);
    });

    /**
     * Starting with a panel is not the same as always having one. The last
     * *dashboard* of a workspace is refused, because a workspace with no
     * dashboard has no view at all; a dashboard with no panels is one you can
     * put a panel on.
     */
    it('lets the last panel be deleted, and does not put one back', async () => {
      // The panel this deletes is added here rather than taken to be the one
      // the dashboard arrived with: what is being claimed is that nothing puts
      // a panel back, and a case that leans on the arrival cannot fail for
      // that reason alone.
      const dashboardId = await aDashboardIn(WORKSPACE_ID);
      const panelId = nextId();
      await asUser('http://cockpit.test/v1/commands/add_panel', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          commandId: nextId(),
          issuedAt: '2026-09-01T10:00:00.000Z',
          workspaceId: WORKSPACE_ID,
          dashboardId,
          panelId,
          name: aName(),
        }),
      });
      expect(await panelsOn(WORKSPACE_ID, dashboardId)).toHaveLength(2);

      await asUser('http://cockpit.test/v1/commands/delete_panel', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          commandId: nextId(),
          issuedAt: '2026-09-01T10:00:00.000Z',
          workspaceId: WORKSPACE_ID,
          panelId,
        }),
      });

      expect(await panelsOn(WORKSPACE_ID, dashboardId)).toEqual(['Panel 1']);

      // And the one it arrived with goes the same way, leaving none - which is
      // the claim: a dashboard may end up with no panels, unlike a workspace,
      // whose last dashboard is refused.
      const [arrived] = (
        (await (
          await asUser(`http://cockpit.test/v1/workspaces/${WORKSPACE_ID}/snapshot`)
        ).json()) as { panels: { id: string; dashboardId: string }[] }
      ).panels
        .filter((panel) => panel.dashboardId === dashboardId)
        .map((panel) => panel.id);
      await asUser('http://cockpit.test/v1/commands/delete_panel', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          commandId: nextId(),
          issuedAt: '2026-09-01T10:00:00.000Z',
          workspaceId: WORKSPACE_ID,
          panelId: arrived,
        }),
      });

      expect(await panelsOn(WORKSPACE_ID, dashboardId)).toEqual([]);
      // Asked a second time, because what would put one back is a read that
      // notices the dashboard has none rather than the delete itself.
      expect(await panelsOn(WORKSPACE_ID, dashboardId)).toEqual([]);
    });
  });

  describe('the dashboards of a workspace are in the order you put them in, and a new one goes last', () => {
    /**
     * A workspace of this rule's own, with the one it arrives with and two
     * more added after it. Its own, because the run shares one store and a
     * case that reordered a workspace every other case reads would move the
     * bar under them.
     */
    async function threeInABar(): Promise<{ workspaceId: string; order: string[] }> {
      const workspaceId = await makeWorkspace(aName());
      const arrived = await theDashboardOf(workspaceId);
      const second = await aDashboardIn(workspaceId);
      const third = await aDashboardIn(workspaceId);
      return { workspaceId, order: [arrived, second, third] };
    }

    it('starts in the order the dashboards were added in', async () => {
      const { workspaceId, order } = await threeInABar();

      expect(await theOrder(workspaceId)).toEqual(order);
    });

    it('comes back in the order it was given, and keeps it for the next person who asks', async () => {
      const { workspaceId, order } = await threeInABar();
      const [first, second, third] = order as [string, string, string];
      const wanted = [third, first, second];

      const response = await reorderDashboards(workspaceId, third, wanted);

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, applied: true });
      // Asked twice rather than once: the order has to be what the store
      // holds, not something the request answered with. An order written
      // nowhere would pass the first of these.
      expect(await theOrder(workspaceId)).toEqual(wanted);
      expect(await theOrder(workspaceId)).toEqual(wanted);
    });

    it('puts a dashboard you add after the ones already there, whatever order they are in', async () => {
      // The half a place counted from the number of *live* dashboards would
      // get wrong, and the reason the count is taken from the highest place
      // rather than from the list: reordering leaves the same count behind, so
      // the new dashboard would land on top of one of them.
      const { workspaceId, order } = await threeInABar();
      const [first, second, third] = order as [string, string, string];
      await reorderDashboards(workspaceId, third, [third, first, second]);

      const added = await aDashboardIn(workspaceId);

      expect(await theOrder(workspaceId)).toEqual([third, first, second, added]);
    });

    it('does not give a deleted dashboard’s place to the next one added', async () => {
      // A place counted from what is still there would reuse the gone
      // dashboard's number, which is a new tab appearing in the middle of the
      // bar rather than at the end of it.
      const { workspaceId, order } = await threeInABar();
      const gone = order[2]!;
      await deleteDashboard(workspaceId, gone);

      const added = await aDashboardIn(workspaceId);

      expect(await theOrder(workspaceId)).toEqual([order[0]!, order[1]!, added]);
    });

    it('closes up when a dashboard is deleted, leaving the rest as they were', async () => {
      const { workspaceId, order } = await threeInABar();
      const [first, second, third] = order as [string, string, string];
      await reorderDashboards(workspaceId, third, [third, first, second]);

      await deleteDashboard(workspaceId, first);

      expect(await theOrder(workspaceId)).toEqual([third, second]);
    });

    it('leaves another workspace’s dashboards in the order they were in', async () => {
      // The order is the workspace's own, so two workspaces reordered at
      // different times know nothing about each other.
      const mine = await threeInABar();
      const elsewhere = await threeInABar();
      const before = await theOrder(elsewhere.workspaceId);

      await reorderDashboards(mine.workspaceId, mine.order[2]!, [
        mine.order[2]!,
        mine.order[0]!,
        mine.order[1]!,
      ]);

      expect(await theOrder(elsewhere.workspaceId)).toEqual(before);
    });

    it('lands on one order when the same one arrives twice', async () => {
      // Twice with a request id that was lost and replaced, which is the shape
      // a retried move really takes: the same places written again are the
      // same places.
      const { workspaceId, order } = await threeInABar();
      const [first, second, third] = order as [string, string, string];
      const wanted = [second, third, first];
      await reorderDashboards(workspaceId, second, wanted);

      const again = await reorderDashboards(workspaceId, second, wanted);

      expect(again.status).toBe(200);
      expect(await theOrder(workspaceId)).toEqual(wanted);
    });

    it('keeps the order of dashboards written before a place could be chosen', async () => {
      /*
       * Written straight into the store, which is the one thing the interface
       * cannot reach any more: every dashboard added through `add_dashboard`
       * is given a real place, so nothing a request can send produces the rows
       * an account already had - a place of 0 on every one of them, the
       * default the column was added with and backfilled over by nothing.
       * What holds their order together is `created_at`, and this is what says
       * so.
       */
      const workspaceId = await makeWorkspace(aName());
      const arrived = await theDashboardOf(workspaceId);
      const older = `${workspaceId}-older`;
      const newer = `${workspaceId}-newer`;
      await inTheStore((sql) => {
        for (const [id, at] of [
          // Inserted newest first, so the row order in the table is the
          // opposite of the answer: a query that fell back to nothing would
          // come back the other way round.
          [newer, '2026-09-03T00:00:00.000Z'],
          [older, '2026-09-02T00:00:00.000Z'],
        ] as const) {
          sql.exec(
            `INSERT INTO dashboards (id, tenant_id, workspace_id, name, folded_name, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
            id,
            ACCOUNT_NAME,
            workspaceId,
            id,
            id,
            at,
          );
        }
      });

      expect(await theOrder(workspaceId)).toEqual([arrived, older, newer]);
    });
  });

  describe('an order of dashboards that are no longer the workspace’s is refused, and the bar is left as it was', () => {
    /**
     * The list comes from a bar painted some time ago, so it can be about a
     * workspace that has moved on since - a dashboard added or deleted in
     * another tab. Which lists count as an order of these dashboards is
     * decided in apps/api/tests/unit/domain/dashboards.test.ts over its whole
     * table; what is asked here is that each way of being wrong is
     * *reachable*, comes back refused, and changes nothing.
     *
     * The two answers differ on purpose. A list that names the same dashboard
     * twice, or that does not name the dashboard it says moved, is refused as
     * a shape - it is wrong on its own terms, whatever the workspace holds. A
     * list that simply describes an older bar is a collision, and the person
     * can make the same move again once it has caught up.
     */
    it.each([
      {
        situation: 'an order made before somebody else added a dashboard',
        order: (live: string[]) => [live[1]!, live[0]!],
        moved: (live: string[]) => live[1]!,
        refusal: 409,
      },
      {
        situation: 'an order made before somebody else deleted one',
        order: (live: string[], gone: string) => [...live, gone],
        moved: (live: string[]) => live[0]!,
        refusal: 409,
      },
      {
        situation: 'an order naming a dashboard of another workspace',
        order: (live: string[], _gone: string, elsewhere: string) => [...live.slice(1), elsewhere],
        moved: (live: string[]) => live[1]!,
        refusal: 409,
      },
      {
        situation: 'an order with the same dashboard in two places',
        order: (live: string[]) => [live[0]!, live[0]!, live[1]!],
        moved: (live: string[]) => live[0]!,
        refusal: 400,
      },
      {
        situation: 'an order that does not name the dashboard it says moved',
        order: (live: string[]) => live,
        moved: () => 'db-nowhere',
        refusal: 400,
      },
      {
        situation: 'no order at all',
        order: () => [],
        moved: (live: string[]) => live[0]!,
        refusal: 400,
      },
    ])('refuses $situation, and stores nothing', async ({ order, moved, refusal }) => {
      const workspaceId = await makeWorkspace(aName());
      await aDashboardIn(workspaceId);
      await aDashboardIn(workspaceId);
      // A dashboard of this workspace that is not there any more, and one that
      // belongs to another workspace entirely, so the rows naming each have
      // something real to name. Made for every row, which costs two requests
      // and keeps the rows from having to know about each other.
      const gone = await aDashboardIn(workspaceId);
      await deleteDashboard(workspaceId, gone);
      const elsewhere = await aDashboardIn(await makeWorkspace(aName()));
      const live = await theOrder(workspaceId);

      const response = await reorderDashboards(
        workspaceId,
        moved(live),
        order(live, gone, elsewhere),
      );

      expect(response.status).toBe(refusal);
      expect(await theOrder(workspaceId)).toEqual(live);
    });

    it('says the dashboards changed, so the same move can be made again', async () => {
      const workspaceId = await makeWorkspace(aName());
      const second = await aDashboardIn(workspaceId);
      const gone = await aDashboardIn(workspaceId);
      await deleteDashboard(workspaceId, gone);
      const live = await theOrder(workspaceId);

      const response = await reorderDashboards(workspaceId, second, [...live, gone]);

      expect(await response.json()).toEqual({
        error: 'the dashboards changed while they were being put in order',
      });
    });

    it('refuses an order against a workspace that is no longer there', async () => {
      const workspaceId = await makeWorkspace(aName());
      const only = await theDashboardOf(workspaceId);
      await asUser('http://cockpit.test/v1/commands/delete_workspace', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          commandId: nextId(),
          issuedAt: '2026-09-01T10:00:00.000Z',
          workspaceId,
        }),
      });

      expect((await reorderDashboards(workspaceId, only, [only])).status).toBe(404);
    });
  });
});
