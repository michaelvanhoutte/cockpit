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
});
