import { afterEach, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { applyD1Migrations, env, runInDurableObject } from 'cloudflare:test';
import type { CommandName, CommandPayload, MostUsedPanels } from '@cockpit/shared';
import { createAccountDb } from '../../../src/accounts/client.js';
import { filingsLandedThisWeek } from '../../../src/accounts/repo.js';
import { ACCOUNT_NAME, DASHBOARD_ID, WORKSPACE_ID, asUser, inTheStore, seedRegister, startFromEmpty, storeNamed } from '../seed.js';

/**
 * Integration level, through the real Worker: when an Item landed on a Panel is
 * a value the filing's rewrite of the Panel's order writes, and the most-used
 * read is a query over those rows with its windows and liveness filters
 * ("Capture: offer today's and this week's most-used Panels…", issue 1743) -
 * neither holds below a real store. Which three of them Capture offers is
 * apps/web/tests/unit/mostUsedPanels.test.ts; a source's filing is
 * pulled-names.test.ts, a recurring item's copy repeating-items.test.ts.
 *
 * The clock is the store's: fixed for every case, and a filing landed as long
 * before it as the change that made it says, as a device's own clock stamps one.
 */

const HOUR = 60 * 60 * 1000;

/** The store's clock for every case: the real time, fixed, so the sign-in the requests carry is still good. */
const NOW = Date.now(); // clock-ok: fixed once as the store's clock, since a sign-in is checked against it

const hoursAgo = (hours: number) => new Date(NOW - hours * HOUR).toISOString();

let seq = 0;
function nextId(): string {
  seq += 1;
  return `018f0000-0000-7000-8000-${String(seq).padStart(12, '0')}`;
}

function post<N extends CommandName>(
  name: N,
  payload: Omit<CommandPayload<N>, 'commandId' | 'issuedAt'>,
  issuedAt = hoursAgo(24 * 30),
  commandId = nextId(),
) {
  return asUser(`http://cockpit.test/v1/commands/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ commandId, issuedAt, ...payload }),
  });
}

async function ok(response: Promise<Response>): Promise<void> {
  expect((await response).status).toBe(200);
}

async function anItem(message: string, workspaceId = WORKSPACE_ID): Promise<string> {
  const itemId = nextId();
  await ok(post('capture_item', { workspaceId, itemId, message }));
  return itemId;
}

async function aPanel(name: string, dashboardId = DASHBOARD_ID, workspaceId = WORKSPACE_ID): Promise<string> {
  const panelId = nextId();
  await ok(post('add_panel', { workspaceId, dashboardId, panelId, name, kind: 'items' }));
  return panelId;
}

async function aDashboard(name: string, workspaceId = WORKSPACE_ID): Promise<string> {
  const dashboardId = nextId();
  await ok(post('add_dashboard', { workspaceId, dashboardId, panelId: nextId(), name }));
  return dashboardId;
}

/** The Items on a Panel now, in order, as its order is written. */
async function orderOn(panelId: string): Promise<string[]> {
  return inTheStore((sql) =>
    sql
      .exec<{ item_id: string }>('SELECT item_id FROM panel_items WHERE panel_id = ? ORDER BY position, item_id', panelId)
      .toArray()
      .map((row) => row.item_id),
  );
}

/** When each Item on a Panel landed there, by Item. */
async function landedOn(panelId: string): Promise<Record<string, string | null>> {
  return inTheStore((sql) =>
    Object.fromEntries(
      sql
        .exec<{ item_id: string; filed_at: string | null }>('SELECT item_id, filed_at FROM panel_items WHERE panel_id = ?', panelId)
        .toArray()
        .map((row) => [row.item_id, row.filed_at]),
    ),
  );
}

/** Puts the Item on top of the Panel, taking it off every other: what a move from the Inbox or a drag sends. */
async function move(itemId: string, panelId: string, at: string, fromPanelIds?: string[]): Promise<void> {
  const order = [itemId, ...(await orderOn(panelId)).filter((id) => id !== itemId)];
  await ok(post('move_item_to_panel', { workspaceId: WORKSPACE_ID, itemId, panelId, order, ...(fromPanelIds ? { fromPanelIds } : {}) }, at));
}

async function alsoShowOn(itemId: string, panelId: string, at: string): Promise<void> {
  const order = [itemId, ...(await orderOn(panelId))];
  await ok(post('add_item_to_panel', { workspaceId: WORKSPACE_ID, itemId, panelId, order }, at));
}

async function mostUsed(): Promise<MostUsedPanels['panels']> {
  const response = await asUser('http://cockpit.test/v1/most-used-panels');
  expect(response.status).toBe(200);
  return ((await response.json()) as MostUsedPanels).panels;
}

const countsOf = (panels: MostUsedPanels['panels']) =>
  Object.fromEntries(panels.map((panel) => [panel.panelName, [panel.lastDay, panel.lastWeek]]));

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Panels', () => {
  describe('an Item on a Panel keeps the time it landed there, and nothing later changes it', () => {
    it('is filed from the Inbox at the time of the filing', async () => {
      const tasks = await aPanel('Tasks');
      const note = await anItem('Send the estimate');

      await move(note, tasks, hoursAgo(2));

      expect(await landedOn(tasks)).toEqual({ [note]: hoursAgo(2) });
    });

    it('lands on the Panel it is moved to at the time of the move', async () => {
      const [from, to] = [await aPanel('Tasks'), await aPanel('Calls')];
      const note = await anItem('Send the estimate');
      await move(note, from, hoursAgo(5));

      await move(note, to, hoursAgo(1), [from]);

      expect([await landedOn(from), await landedOn(to)]).toEqual([{}, { [note]: hoursAgo(1) }]);
    });

    it('lands on a second Panel by Also show on…, keeping its time on the first', async () => {
      const [first, second] = [await aPanel('Tasks'), await aPanel('Calls')];
      const note = await anItem('Send the estimate');
      await move(note, first, hoursAgo(5));

      await alsoShowOn(note, second, hoursAgo(1));

      expect([await landedOn(first), await landedOn(second)]).toEqual([{ [note]: hoursAgo(5) }, { [note]: hoursAgo(1) }]);
    });

    it('lands on both Panels File on named at the time of the capture', async () => {
      const [first, second] = [await aPanel('Tasks'), await aPanel('Calls')];
      const note = nextId();

      await ok(post('capture_item', { workspaceId: WORKSPACE_ID, itemId: note, message: 'Send the estimate', panelIds: [first, second] }, hoursAgo(3)));

      expect([await landedOn(first), await landedOn(second)]).toEqual([{ [note]: hoursAgo(3) }, { [note]: hoursAgo(3) }]);
    });

    it.each([
      { situation: 'another Item filed on the same Panel', reorders: false },
      { situation: 'the Panel reordered', reorders: true },
    ])('keeps every other Item’s time with $situation', async ({ reorders }) => {
      const tasks = await aPanel('Tasks');
      const [first, second] = [await anItem('First'), await anItem('Second')];
      await move(first, tasks, hoursAgo(50));
      await move(second, tasks, hoursAgo(40));

      if (reorders) {
        await ok(post('move_item_to_panel', { workspaceId: WORKSPACE_ID, itemId: first, panelId: tasks, order: [first, second] }, hoursAgo(1)));
      } else {
        await move(await anItem('Third'), tasks, hoursAgo(1));
      }

      expect(await landedOn(tasks)).toMatchObject({ [first]: hoursAgo(50), [second]: hoursAgo(40) });
    });

    it('keeps the time of an Item finished more than a day ago, which the filing’s order leaves out', async () => {
      const tasks = await aPanel('Tasks');
      const finished = await anItem('Long done');
      await move(finished, tasks, hoursAgo(60));
      await ok(post('set_done', { workspaceId: WORKSPACE_ID, itemId: finished, done: true }, hoursAgo(30)));
      const note = await anItem('New');

      await ok(post('move_item_to_panel', { workspaceId: WORKSPACE_ID, itemId: note, panelId: tasks, order: [note] }, hoursAgo(1)));

      expect(await landedOn(tasks)).toEqual({ [finished]: hoursAgo(60), [note]: hoursAgo(1) });
    });

    it('keeps the first time when the same filing arrives twice', async () => {
      const tasks = await aPanel('Tasks');
      const note = await anItem('Send the estimate');
      const commandId = nextId();
      const filing = { workspaceId: WORKSPACE_ID, itemId: note, panelId: tasks, order: [note] };

      await ok(post('move_item_to_panel', filing, hoursAgo(2), commandId));
      await ok(post('move_item_to_panel', filing, hoursAgo(1), commandId));

      expect(await landedOn(tasks)).toEqual({ [note]: hoursAgo(2) });
    });
  });
});

describe('Capture', () => {
  describe('the most-used read counts, per Panel, the Items still on it that landed in the last 24 hours and 7 days', () => {
    it('counts an Item landed 2 hours ago in both, and one landed 3 days ago in the week only', async () => {
      const tasks = await aPanel('Tasks');
      await move(await anItem('Recent'), tasks, hoursAgo(2));
      await move(await anItem('This week'), tasks, hoursAgo(72));

      expect(countsOf(await mostUsed())).toEqual({ Tasks: [1, 2] });
    });

    it('leaves out an Item landed 8 days ago, and a Panel holding only that', async () => {
      const [old, tasks] = [await aPanel('Old'), await aPanel('Tasks')];
      await move(await anItem('Eight days'), old, hoursAgo(24 * 8));
      await move(await anItem('Eight days too'), tasks, hoursAgo(24 * 8));
      await move(await anItem('Today'), tasks, hoursAgo(1));

      expect(countsOf(await mostUsed())).toEqual({ Tasks: [1, 1] });
    });

    it.each([
      { situation: 'moved off the Panel', after: 'moved', counted: false },
      { situation: 'dismissed', after: 'dismissed', counted: false },
      { situation: 'marked done', after: 'done', counted: true },
    ])('counts an Item landed this week, then $situation, only while it is still there and not dismissed', async ({ after, counted }) => {
      const [tasks, calls] = [await aPanel('Tasks'), await aPanel('Calls')];
      const note = await anItem('Landed this week');
      await move(note, tasks, hoursAgo(48));

      if (after === 'moved') await move(note, calls, hoursAgo(30 * 24), [tasks]);
      if (after === 'dismissed') await ok(post('set_dismissed', { workspaceId: WORKSPACE_ID, itemId: note, dismissed: true }, hoursAgo(1)));
      if (after === 'done') await ok(post('set_done', { workspaceId: WORKSPACE_ID, itemId: note, done: true }, hoursAgo(1)));

      expect(countsOf(await mostUsed()).Tasks).toEqual(counted ? [0, 1] : undefined);
    });

    it('does not count a filing from before the time was kept', async () => {
      const tasks = await aPanel('Tasks');
      const note = await anItem('Filed before release');
      await move(note, tasks, hoursAgo(2));
      await inTheStore((sql) => sql.exec('UPDATE panel_items SET filed_at = NULL WHERE item_id = ?', note));

      expect(await mostUsed()).toEqual([]);
    });

    it.each([
      { situation: 'the Panel', gone: 'panel' },
      { situation: 'its Dashboard', gone: 'dashboard' },
      { situation: 'its Workspace', gone: 'workspace' },
    ])('leaves out a Panel once $situation is deleted', async ({ gone }) => {
      const workspaceId = nextId();
      await ok(post('create_workspace', { workspaceId, panelId: nextId(), name: 'Falcon' }));
      const dashboardId = await aDashboard('Board', workspaceId);
      const panelId = await aPanel('Tasks', dashboardId, workspaceId);
      const note = await anItem('Landed', workspaceId);
      await ok(post('move_item_to_panel', { workspaceId, itemId: note, panelId, order: [note] }, hoursAgo(2)));
      expect(countsOf(await mostUsed())).toEqual({ Tasks: [1, 1] });

      if (gone === 'panel') await ok(post('delete_panel', { workspaceId, panelId }, hoursAgo(1)));
      if (gone === 'dashboard') await ok(post('delete_dashboard', { workspaceId, dashboardId }, hoursAgo(1)));
      if (gone === 'workspace') await ok(post('delete_workspace', { workspaceId }, hoursAgo(1)));

      expect(await mostUsed()).toEqual([]);
    });

    it('names each Panel’s Dashboard and Workspace and when it was last filed on, across Workspaces', async () => {
      const falcon = await aDashboard('Falcon');
      const tasks = await aPanel('Tasks', falcon);
      await move(await anItem('Earlier'), tasks, hoursAgo(30));
      await move(await anItem('Later'), tasks, hoursAgo(3));
      const workspaceId = nextId();
      await ok(post('create_workspace', { workspaceId, panelId: nextId(), name: 'Home' }));
      const atlas = await aDashboard('Atlas', workspaceId);
      const homeTasks = await aPanel('Tasks', atlas, workspaceId);
      const note = await anItem('At home', workspaceId);
      await ok(post('move_item_to_panel', { workspaceId, itemId: note, panelId: homeTasks, order: [note] }, hoursAgo(5)));

      const read = await mostUsed();

      expect(read).toHaveLength(2);
      expect(read).toEqual(
        expect.arrayContaining([
          { panelId: tasks, panelName: 'Tasks', dashboardName: 'Falcon', workspaceId: WORKSPACE_ID, lastDay: 1, lastWeek: 2, lastFiledAt: hoursAgo(3) },
          { panelId: homeTasks, panelName: 'Tasks', dashboardName: 'Atlas', workspaceId, lastDay: 1, lastWeek: 1, lastFiledAt: hoursAgo(5) },
        ]),
      );
    });

    it('reads only this week’s filings, by when they landed, out of a year of them', async () => {
      const tasks = await aPanel('Tasks');
      const YEAR_OF_FILINGS = 20_000;
      // A year of filings, one every 1,577 seconds, written straight into the
      // store: the subject is how the read finds this week's among them.
      await inTheStore((sql) => {
        sql.exec(
          `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
           INSERT INTO items (id, tenant_id, workspace_id, source, title, status, unseen, created_at, updated_at)
           SELECT 'bulk-' || i, ?, ?, 'internal', 'Filed ' || i, 'to_process', 0, ?, ? FROM n`,
          YEAR_OF_FILINGS,
          ACCOUNT_NAME,
          WORKSPACE_ID,
          hoursAgo(24 * 400),
          hoursAgo(24 * 400),
        );
        sql.exec(
          `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
           INSERT INTO panel_items (tenant_id, panel_id, item_id, position, created_at, filed_at)
           SELECT ?, ?, 'bulk-' || i, i, ?, strftime('%Y-%m-%dT%H:%M:%fZ', ?, '-' || (i * 1577) || ' seconds') FROM n`,
          YEAR_OF_FILINGS,
          ACCOUNT_NAME,
          tasks,
          hoursAgo(1),
          hoursAgo(0),
        );
      });

      const plan = await runInDurableObject(storeNamed(ACCOUNT_NAME), (_instance, state) => {
        const { sql, params } = filingsLandedThisWeek(createAccountDb(state.storage), ACCOUNT_NAME, new Date(NOW)).toSQL();
        return state.storage.sql
          .exec<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, ...params)
          .toArray()
          .map((row) => row.detail);
      });

      expect(plan).toContainEqual(expect.stringMatching(/panel_items USING INDEX panel_items_tenant_filed \(tenant_id=\? AND filed_at>\?\)/));
      // 7 days of 1,577-second gaps.
      expect(countsOf(await mostUsed()).Tasks?.[1]).toBe(Math.floor((7 * 24 * 3600) / 1577));
    });
  });
});
