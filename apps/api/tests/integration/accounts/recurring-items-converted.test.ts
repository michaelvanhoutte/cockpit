import { afterEach, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { abortAllDurableObjects, applyD1Migrations, env, runDurableObjectAlarm } from 'cloudflare:test';
import type { CommandName, Item, Series } from '@cockpit/shared';
import { accountChanges } from '../../../src/accounts/changes.js';
import {
  ACCOUNT_NAME,
  DASHBOARD_ID,
  WORKSPACE_ID,
  alsoWorkspaces,
  asUser,
  inStoreAsItIs,
  inTheStore,
  seedRegister,
  startFromEmpty,
  storeNamed,
} from '../seed.js';

/**
 * Integration level, through the account's real store: every series the
 * retired Repeats chip set becomes a recurring item that owns its content, once, when
 * the store is first opened after the release ("Make each copy of a recurring
 * item from its own series", issue 1448). Only the store can say what one
 * change does to the rows already in it, and when it runs.
 *
 * **Arranged as a store from before the change over**: series set through the
 * real Worker, then put back the way the release before left them - holding
 * nothing but their rule, and the change unrecorded - and opened the way the
 * first request of the day opens it. Dated in 2090, as repeating-items.test.ts
 * explains, so no alarm fires by itself while a case runs.
 */

const CHANGE_OVER = '0095-series-masters-from-latest-copy';
const ZONE = 'Europe/Brussels';
const SET = '2090-01-02T09:00:00.000Z';
const FIRST = '2090-01-09';
const WEEKLY = { frequency: 'weekly', nextOn: FIRST, dueAfterDays: null, timeZone: ZONE } as const;
const STOPPED_BY_WHOEVER = '2090-01-02T10:00:00.000Z';

let seq = 0;
function nextId(): string {
  seq += 1;
  return `018f0000-0000-7000-8000-${String(seq).padStart(12, '0')}`;
}

async function change(name: CommandName, payload: Record<string, unknown>, issuedAt = SET): Promise<void> {
  const res = await asUser(`http://cockpit.test/v1/commands/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ commandId: nextId(), issuedAt, workspaceId: WORKSPACE_ID, ...payload }),
  });
  expect(res.status, await res.clone().text()).toBe(200);
}

/** An Item captured at `at`, so the one captured later is the latest of its series. */
async function anItem(title: string, at = '2090-01-01T09:00:00.000Z', workspaceId = WORKSPACE_ID): Promise<string> {
  const itemId = nextId();
  await change('capture_item', { itemId, message: title, workspaceId }, at);
  return itemId;
}

async function aPanel(name: string): Promise<string> {
  const panelId = nextId();
  await change('add_panel', { dashboardId: DASHBOARD_ID, panelId, name, kind: 'items' }, '2090-01-01T08:00:00.000Z');
  return panelId;
}

async function fileOn(itemId: string, panelId: string): Promise<void> {
  const held = (await workspace()).filings.filter((one) => one.panelId === panelId).map((one) => one.itemId);
  await change('add_item_to_panel', { itemId, panelId, order: [itemId, ...held] }, '2090-01-01T10:00:00.000Z');
}

interface Read {
  items: Item[];
  filings: { panelId: string; itemId: string; position: number }[];
  series: Series[];
}

async function workspace(): Promise<Read> {
  const res = await asUser(`http://cockpit.test/v1/workspaces/${WORKSPACE_ID}/snapshot`);
  expect(res.status).toBe(200);
  return (await res.json()) as Read;
}

/**
 * A series `first` is the first Item of, with `later` Items of it made after - each the latest in turn -
 * and its id. Made as a recurring item and linked to its Items, which is all a series the retired Repeats
 * chip set was; `asBeforeTheChangeOver` then takes the content off it again.
 */
async function aSeries(first: string, ...later: string[]): Promise<string> {
  const seriesId = nextId();
  const { workspace_id } = await inTheStore((sql) =>
    sql.exec<{ workspace_id: string }>('SELECT workspace_id FROM items WHERE id = ?', first).one(),
  );
  await change('create_recurring_item', {
    seriesId,
    workspaceId: workspace_id,
    title: 'Made before the change over',
    description: '',
    priority: null,
    panelIds: [],
    repeat: WEEKLY,
  });
  for (const itemId of [first, ...later]) {
    await inTheStore((sql) => sql.exec('UPDATE items SET series_id = ? WHERE id = ?', seriesId, itemId));
  }
  return seriesId;
}

/**
 * The store as the release before this one leaves it: every series holding only
 * its rule, filed on no Panel, and the change over not yet recorded - and no
 * copy of it held in memory believing itself up to date.
 */
async function asBeforeTheChangeOver(): Promise<void> {
  await inTheStore((sql) => {
    sql.exec('DELETE FROM series_panels');
    sql.exec('UPDATE series SET workspace_id = NULL, title = NULL, description = NULL, priority = NULL');
    sql.exec('DELETE FROM account_changes WHERE name = ?', CHANGE_OVER);
  });
  await abortAllDurableObjects();
}

interface Master {
  id: string;
  workspace_id: string | null;
  title: string | null;
  description: string | null;
  priority: string | null;
  stopped_at: string | null;
  panels: string[];
}

/** Every series as the store now holds it, without opening it again. */
function mastersAsTheyAre(): Promise<Master[]> {
  return inStoreAsItIs(ACCOUNT_NAME, (sql) =>
    sql
      .exec<Omit<Master, 'panels'>>('SELECT id, workspace_id, title, description, priority, stopped_at FROM series ORDER BY id')
      .toArray()
      .map((row) => ({
        ...row,
        panels: sql
          .exec<{ panel_id: string }>('SELECT panel_id FROM series_panels WHERE series_id = ? ORDER BY position', row.id)
          .toArray()
          .map((one) => one.panel_id),
      })),
  );
}

/** The store opened by the first read of the day, and every series as it then holds it. */
async function mastersOnceOpened(): Promise<Master[]> {
  await workspace();
  return mastersAsTheyAre();
}

const changeOverRecorded = () =>
  inStoreAsItIs(ACCOUNT_NAME, (sql) => sql.exec('SELECT name FROM account_changes WHERE name = ?', CHANGE_OVER).toArray().length);

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Item editing', () => {
  describe('each series the Repeats chip set becomes a recurring item made from its latest Item, once', () => {
    it('takes the latest Item’s title, description, priority, Workspace and both its live Panels, Done or not', async () => {
      const older = await anItem('Weekly review, first week');
      const latest = await anItem('Weekly review', '2090-01-01T09:30:00.000Z');
      await change('set_description', { itemId: latest, description: 'Go through the open items' });
      await change('set_priority', { itemId: latest, priority: 'high' });
      const reviews = await aPanel('Reviews');
      const fridays = await aPanel('Fridays');
      await fileOn(latest, reviews);
      await fileOn(latest, fridays);
      await change('set_done', { itemId: latest, done: true });
      const seriesId = await aSeries(older, latest);
      await asBeforeTheChangeOver();

      expect(await mastersOnceOpened()).toEqual([
        {
          id: seriesId,
          workspace_id: WORKSPACE_ID,
          title: 'Weekly review',
          description: 'Go through the open items',
          priority: 'high',
          stopped_at: null,
          panels: [reviews, fridays],
        },
      ]);
    });

    it('takes a dismissed latest Item’s content all the same', async () => {
      const itemId = await anItem('Pay the rent');
      await change('set_description', { itemId, description: 'Before the 5th' });
      await aSeries(itemId);
      await change('set_dismissed', { itemId, dismissed: true }, '2090-01-03T09:00:00.000Z');
      await asBeforeTheChangeOver();

      expect(await mastersOnceOpened()).toMatchObject([{ title: 'Pay the rent', description: 'Before the 5th', stopped_at: null }]);
    });

    it.each([
      { situation: 'on a deleted Panel and a live one, files on only the live one', panels: 2, deleted: 1 },
      { situation: 'on no Panel, files in the Inbox', panels: 0, deleted: 0 },
    ])('$situation', async ({ panels: count, deleted }) => {
      const itemId = await anItem('Weekly review');
      const panels: string[] = [];
      for (let n = 0; n < count; n += 1) {
        const panelId = await aPanel(`Panel ${n + 2}`);
        await fileOn(itemId, panelId);
        panels.push(panelId);
      }
      await aSeries(itemId);
      for (const panelId of panels.slice(0, deleted)) await change('delete_panel', { panelId }, '2090-01-03T09:00:00.000Z');
      await asBeforeTheChangeOver();

      expect(await mastersOnceOpened()).toMatchObject([{ title: 'Weekly review', panels: panels.slice(deleted) }]);
    });

    it.each([
      { situation: 'with a next action, by that next action on one line', nextAction: 'Call\nthe plumber', named: 'Call the plumber' },
      { situation: 'with none, as Untitled', nextAction: null, named: 'Untitled' },
    ])('names a series whose latest Item has no title as its row names it: $situation', async ({ nextAction, named }) => {
      const itemId = await anItem('Weekly review');
      await change('set_title', { itemId, title: '' });
      if (nextAction !== null) await change('set_next_action', { itemId, nextAction });
      await aSeries(itemId);
      await asBeforeTheChangeOver();

      expect((await mastersOnceOpened())[0]?.title).toBe(named);
    });

    it('leaves a stopped series stopped and holding nothing', async () => {
      const itemId = await anItem('Weekly review');
      const seriesId = await aSeries(itemId);
      await change('delete_recurring_item', { seriesId }, STOPPED_BY_WHOEVER);
      await asBeforeTheChangeOver();

      expect(await mastersOnceOpened()).toMatchObject([{ title: null, workspace_id: null, stopped_at: STOPPED_BY_WHOEVER, panels: [] }]);
    });

    it.each([
      {
        situation: 'that no Item names',
        arrange: async () => {
          await aSeries(await anItem('Weekly review'));
          await inTheStore((sql) => sql.exec('UPDATE items SET series_id = NULL'));
        },
      },
      {
        situation: 'whose Workspace is gone',
        arrange: async () => {
          await alsoWorkspaces();
          const itemId = await anItem('Weekly review', '2090-01-01T09:00:00.000Z', 'ws-atlas');
          await aSeries(itemId);
          await change('delete_workspace', { workspaceId: 'ws-atlas' }, '2090-01-03T09:00:00.000Z');
        },
      },
    ])('stops a running series $situation, holding nothing, and says so', async ({ arrange }) => {
      await arrange();
      await asBeforeTheChangeOver();
      const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const [master] = await mastersOnceOpened();

      expect(master).toMatchObject({ title: null, panels: [] });
      expect(master?.stopped_at).not.toBeNull();
      const said = warned.mock.calls.map(([line]) => String(line)).filter((line) => line.includes('were stopped'));
      expect(said.map((line) => (JSON.parse(line) as { data: { rows: number } }).data.rows)).toEqual([1]);
    });

    it('converts every one of more series than a screen lists, in one account', async () => {
      const MANY = 150;
      const template = await anItem('Recurring 0');
      const seriesId = await aSeries(template);
      await inTheStore((sql) => {
        const columns = (table: string) =>
          sql.exec<{ name: string }>(`PRAGMA table_info(${table})`).toArray().map((column) => column.name);
        const seriesColumns = columns('series');
        const itemColumns = columns('items');
        for (let n = 1; n < MANY; n += 1) {
          const copy = { series: nextId(), item: nextId() };
          sql.exec(
            `INSERT INTO series (${seriesColumns.join(', ')})
             SELECT ${seriesColumns.map((name) => (name === 'id' ? '?' : name)).join(', ')} FROM series WHERE id = ?`,
            copy.series,
            seriesId,
          );
          const replaced: Record<string, string> = { id: copy.item, series_id: copy.series, title: `Recurring ${n}` };
          const values = itemColumns.filter((name) => name in replaced).map((name) => replaced[name]!);
          sql.exec(
            `INSERT INTO items (${itemColumns.join(', ')})
             SELECT ${itemColumns.map((name) => (name in replaced ? '?' : name)).join(', ')} FROM items WHERE id = ?`,
            ...values,
            template,
          );
        }
      });
      await asBeforeTheChangeOver();

      const masters = await mastersOnceOpened();

      expect(masters).toHaveLength(MANY);
      expect(new Set(masters.map((one) => one.title))).toEqual(new Set(Array.from({ length: MANY }, (_, n) => `Recurring ${n}`)));
    });
  });

  describe('the change over lands whole or not at all, and once', () => {
    it('fills no series and is not recorded when one of its writes fails, and fills every one on the next opening', async () => {
      const first = await anItem('Weekly review');
      const second = await anItem('Pay the rent');
      await fileOn(first, await aPanel('Reviews'));
      await aSeries(first);
      const refused = await aSeries(second);
      await asBeforeTheChangeOver();
      await inStoreAsItIs(ACCOUNT_NAME, (sql) =>
        sql.exec(
          `CREATE TRIGGER refuse_one BEFORE UPDATE OF title ON series WHEN NEW.id = '${refused}' BEGIN SELECT RAISE(ABORT, 'refused'); END`,
        ),
      );
      vi.spyOn(console, 'error').mockImplementation(() => {});

      expect(await storeNamed(ACCOUNT_NAME).workspaces(ACCOUNT_NAME)).toMatchObject({ status: 'not-up-to-date' });
      expect((await mastersAsTheyAre()).map(({ title, panels }) => ({ title, panels }))).toEqual([
        { title: null, panels: [] },
        { title: null, panels: [] },
      ]);
      expect(await changeOverRecorded()).toBe(0);

      await inStoreAsItIs(ACCOUNT_NAME, (sql) => sql.exec('DROP TRIGGER refuse_one'));
      await abortAllDurableObjects();

      expect((await mastersOnceOpened()).map((one) => one.title)).toEqual(['Weekly review', 'Pay the rent']);
      expect(await changeOverRecorded()).toBe(1);
    });

    it('writes nothing more when it is carried a second time, after the latest Item has changed', async () => {
      const itemId = await anItem('Weekly review');
      await fileOn(itemId, await aPanel('Reviews'));
      await aSeries(itemId);
      await asBeforeTheChangeOver();
      const converted = await mastersOnceOpened();
      await change('set_title', { itemId, title: 'Weekly review, this week only' }, '2090-01-03T09:00:00.000Z');
      await fileOn(itemId, await aPanel('Fridays'));

      const again = accountChanges(ACCOUNT_NAME).find((one) => one.name === CHANGE_OVER)!;
      await inTheStore((sql) => {
        for (const statement of again.statements) sql.exec(statement.sql, ...(statement.params ?? []));
      });

      expect(await mastersAsTheyAre()).toEqual(converted);
    });

    it('runs before the first copy when the alarm is the first to open the store, so the copy carries the latest Item’s content', async () => {
      const older = await anItem('Weekly review, first week');
      const latest = await anItem('Weekly review', '2090-01-01T09:30:00.000Z');
      await change('set_description', { itemId: latest, description: 'Go through the open items' });
      const reviews = await aPanel('Reviews');
      await fileOn(latest, reviews);
      await change('set_done', { itemId: latest, done: true });
      await change('set_done', { itemId: older, done: true });
      await aSeries(older, latest);
      await asBeforeTheChangeOver();

      vi.useFakeTimers({ toFake: ['Date'], now: Date.parse(`${FIRST}T08:00:00.000Z`) });
      try {
        await runDurableObjectAlarm(storeNamed(ACCOUNT_NAME));
      } finally {
        vi.useRealTimers();
      }

      const read = await workspace();
      const fresh = read.items.find((item) => item.seriesId !== null && item.id !== older && item.id !== latest);
      expect(fresh).toMatchObject({ title: 'Weekly review', description: 'Go through the open items', completedAt: null });
      expect(read.filings.filter((one) => one.panelId === reviews).sort((a, b) => a.position - b.position)[0]?.itemId).toBe(fresh?.id);
    });
  });
});
