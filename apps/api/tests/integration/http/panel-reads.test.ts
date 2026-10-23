import { beforeEach, describe, expect, inject, it } from 'vitest';
import { applyD1Migrations, env, SELF } from 'cloudflare:test';
import {
  DASHBOARD_ID,
  OTHER_USER_ID,
  USER_ID,
  WORKSPACE_ID,
  alsoWorkspaces,
  asUser,
  seedRegister,
  startFromEmpty,
} from '../seed.js';
import { ORIGIN, connected } from './connected-apps.support.js';
import listSample from '../../../../../packages/shared/samples/panel-list.sample.json';
import filterSample from '../../../../../packages/shared/samples/panel-read.sample.json';
import flatSample from '../../../../../packages/shared/samples/panel-read-flat.sample.json';
import { satisfiesSample } from '../../samples.js';

/**
 * Integration level, through the whole Worker, with an access token the
 * in-process OAuth server issued ("Read a Panel from an app allowed only to
 * read, and open Capture from its address", issue 1445). What is proved here is
 * the wiring - which Workspace's rows are read, that the phone's day is the one
 * judged by, that a Panel that cannot be read says nothing about why. Which Items
 * a Panel shows, their order and their groups are the rules the browser draws
 * with, in packages/shared/tests/unit/domain; who may reach the reads at all is
 * apps/api/tests/integration/http/panel-reads-access.test.ts.
 */

const PANELS = `${ORIGIN}/apps/v1/panels`;
const AT = '2026-10-01T10:00:00.000Z';
/** A day far enough from the one this Worker is run on that judging by its clock could not pass for judging by the phone's. */
const FAR_AHEAD = '2999-01-02';
const THE_DAY_BEFORE = '2999-01-01';

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
});

let seq = 0;
const nextId = () => `018f0000-0000-7000-8000-${String(++seq).padStart(12, '0')}`;

async function send(command: string, body: Record<string, unknown>, userId: string = USER_ID): Promise<Response> {
  return asUser(
    `${ORIGIN}/v1/commands/${command}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commandId: nextId(), issuedAt: AT, workspaceId: WORKSPACE_ID, ...body }),
    },
    userId,
  );
}

async function sent(command: string, body: Record<string, unknown>, userId: string = USER_ID): Promise<void> {
  expect((await send(command, body, userId)).status, command).toBe(200);
}

/** A Panel on the first Dashboard, made in the order the cases ask for them. */
async function aPanel(name: string, kind: 'items' | 'text' | 'filter' = 'items', userId: string = USER_ID): Promise<string> {
  const panelId = nextId();
  await sent('add_panel', { dashboardId: DASHBOARD_ID, panelId, name, kind }, userId);
  return panelId;
}

type Held = { priority?: 'low' | 'normal' | 'high'; dueDate?: string; on?: string[] };

/** An Item captured with what the case needs on it, filed where it says. */
async function anItem(title: string, { priority, dueDate, on = [] }: Held = {}, userId: string = USER_ID): Promise<string> {
  const itemId = nextId();
  await sent(
    'capture_item',
    {
      itemId,
      message: title,
      ...(priority ? { priority } : {}),
      ...(dueDate ? { dueDate } : {}),
      ...(on.length > 0 ? { panelIds: on } : {}),
    },
    userId,
  );
  return itemId;
}

interface Row {
  itemId: string;
  label: string;
  priority: string | null;
  dueDate: string | null;
  places: string[];
}
interface Read {
  panel: { id: string; name: string; kind: string; dashboardId: string };
  workspace: { id: string; name: string; color: string };
  count: number;
  groups: { heading: { name: string; dashboard: string | null } | null; rows: Row[] }[];
}

/** A widget's token, for the person whose Panels it reads. */
async function aWidget(userId: string = USER_ID): Promise<string> {
  return (await connected(userId, 'Cockpit widget', { reading: true })).token;
}

async function readPanel(token: string, panelId: string, date = FAR_AHEAD): Promise<Response> {
  return SELF.fetch(`${PANELS}/${panelId}?date=${date}`, { headers: { authorization: `Bearer ${token}` } });
}

async function rowsOf(token: string, panelId: string, date = FAR_AHEAD): Promise<Read> {
  const answer = await readPanel(token, panelId, date);
  expect(answer.status).toBe(200);
  return (await answer.json()) as Read;
}

const labels = (read: Read) => read.groups.flatMap((group) => group.rows.map((row) => row.label));

interface Listed {
  workspaces: { id: string; name: string; color: string; dashboards: { id: string; name: string; panels: { id: string; name: string; kind: string }[] }[] }[];
}
async function listOf(token: string): Promise<Listed> {
  const answer = await SELF.fetch(PANELS, { headers: { authorization: `Bearer ${token}` } });
  expect(answer.status).toBe(200);
  return (await answer.json()) as Listed;
}

describe('Panels', () => {
  describe('the Panel list holds every Workspace’s Dashboards and Panels in the order Cockpit shows them, with no Items', () => {
    it('never holds another person’s Workspace, and holds every one of the person’s own', async () => {
      await alsoWorkspaces();
      await aPanel('Michael only');
      await aPanel('Ada only', 'items', OTHER_USER_ID);

      const mine = await listOf(await aWidget(USER_ID));
      const theirs = await listOf(await aWidget(OTHER_USER_ID));
      const panelNames = (list: Listed) => list.workspaces.flatMap((w) => w.dashboards.flatMap((d) => d.panels.map((p) => p.name)));

      expect(mine.workspaces.map((w) => w.name)).toEqual(['Workspace 1', 'Atlas Copco', 'Personal']);
      expect(theirs.workspaces.map((w) => w.name)).toEqual(['Workspace 1']);
      expect(panelNames(mine)).toContain('Michael only');
      expect(panelNames(mine)).not.toContain('Ada only');
      expect(panelNames(theirs)).toContain('Ada only');
      expect(panelNames(theirs)).not.toContain('Michael only');
    });

    it('leaves out a Panel deleted since', async () => {
      const kept = await aPanel('Kept');
      const gone = await aPanel('Gone');
      await sent('delete_panel', { dashboardId: DASHBOARD_ID, panelId: gone });

      const ids = (await listOf(await aWidget())).workspaces.flatMap((w) => w.dashboards.flatMap((d) => d.panels.map((p) => p.id)));

      expect(ids).toContain(kept);
      expect(ids).not.toContain(gone);
    });
  });

  describe('a Panel read returns exactly what Cockpit draws on that Panel, in the same order and groups', () => {
    it('gives a Panel of items its Items in the order it holds them', async () => {
      const panel = await aPanel('Reading list');
      // Each lands at the top, so the order held is the reverse of the order captured.
      await anItem('First in', { on: [panel] });
      await anItem('Second in', { on: [panel] });
      await anItem('Third in', { on: [panel] });

      expect(labels(await rowsOf(await aWidget(), panel))).toEqual(['Third in', 'Second in', 'First in']);
    });

    it('gives a Filter panel grouped by Panel a heading per Panel in board order, an Item on two Panels under each', async () => {
      const dashboardId = nextId();
      await sent('add_dashboard', { dashboardId, panelId: nextId(), name: 'Grouped' });
      const [admin, falcon, gathers] = [nextId(), nextId(), nextId()];
      await sent('add_panel', { dashboardId, panelId: admin, name: 'Admin', kind: 'items' });
      await sent('add_panel', { dashboardId, panelId: falcon, name: 'Falcon', kind: 'items' });
      await sent('add_panel', { dashboardId, panelId: gathers, name: 'This week', kind: 'filter' });
      await sent('set_panel_filter', {
        dashboardId,
        panelId: gathers,
        rows: [[{ field: 'dashboard', values: [dashboardId] }]],
        groupBy: 'panel',
      });
      await anItem('On both', { priority: 'high', on: [admin, falcon] });
      await anItem('On Falcon', { on: [falcon] });

      const read = await rowsOf(await aWidget(), gathers);

      expect(read.groups.map((g) => [g.heading?.name, g.rows.map((r) => r.label)])).toEqual([
        ['Admin', ['On both']],
        ['Falcon', ['On both', 'On Falcon']],
      ]);
      // Counted once, however many headings it sits under.
      expect(read.count).toBe(2);
    });

    it('judges a Filter panel for Due today by the day the phone sends, not by the day this Worker is on', async () => {
      const gathers = await aPanel('Due today', 'filter');
      await sent('set_panel_filter', {
        dashboardId: DASHBOARD_ID,
        panelId: gathers,
        rows: [[{ field: 'dueDate', window: 'today', orOverdue: false }]],
      });
      const filedOn = await aPanel('Falcon');
      await anItem('Due on the phone’s day', { dueDate: FAR_AHEAD, on: [filedOn] });
      const token = await aWidget();

      expect(labels(await rowsOf(token, gathers, FAR_AHEAD))).toEqual(['Due on the phone’s day']);
      expect(labels(await rowsOf(token, gathers, THE_DAY_BEFORE))).toEqual([]);
    });

    it('leaves out an Item that is finished or dismissed', async () => {
      const panel = await aPanel('Falcon');
      const finished = await anItem('Finished', { on: [panel] });
      const dismissed = await anItem('Dismissed', { on: [panel] });
      await anItem('Still to do', { on: [panel] });
      await sent('set_done', { itemId: finished, done: true });
      await sent('set_dismissed', { itemId: dismissed, dismissed: true });

      expect(labels(await rowsOf(await aWidget(), panel))).toEqual(['Still to do']);
    });

    it('says a Panel with nothing on it has no rows and a count of 0', async () => {
      const panel = await aPanel('Empty');

      const read = await rowsOf(await aWidget(), panel);

      expect([read.count, labels(read)]).toEqual([0, []]);
    });

    it('gives a Panel of 100 Items all of them, none left off', async () => {
      const panel = await aPanel('A lot');
      for (let n = 1; n <= 100; n += 1) await anItem(`Item ${n}`, { on: [panel] });

      const read = await rowsOf(await aWidget(), panel);

      expect([read.count, labels(read)]).toEqual([100, expect.arrayContaining(['Item 1', 'Item 50', 'Item 100'])]);
      expect(new Set(labels(read)).size).toBe(100);
    });

    it('never mixes Workspaces: a Filter panel reads only the Items of its own', async () => {
      await alsoWorkspaces();
      const gathers = await aPanel('Everything high', 'filter');
      await sent('set_panel_filter', {
        dashboardId: DASHBOARD_ID,
        panelId: gathers,
        rows: [[{ field: 'priority', values: ['high'] }]],
      });
      const mine = await aPanel('Mine');
      await anItem('In this Workspace', { priority: 'high', on: [mine] });
      // Another Workspace of the same person, with an Item that meets the very same condition.
      const elsewhere = nextId();
      await sent('add_panel', { workspaceId: 'ws-atlas', dashboardId: 'ws-atlas-dashboard-1', panelId: elsewhere, name: 'Elsewhere' });
      const there = nextId();
      await sent('capture_item', {
        workspaceId: 'ws-atlas',
        itemId: there,
        message: 'In another Workspace',
        priority: 'high',
        panelIds: [elsewhere],
      });

      expect(labels(await rowsOf(await aWidget(), gathers))).toEqual(['In this Workspace']);
    });
  });

  describe('each row carries what the widget draws: its label, priority, due date and every other Panel it is filed on, or Inbox', () => {
    it('says a real Panel’s row with its label, priority, due date and the other Panel it is on', async () => {
      const falcon = await aPanel('Falcon');
      const admin = await aPanel('Admin');
      await anItem('Send the forecast', { priority: 'high', dueDate: '2026-10-21', on: [falcon, admin] });

      const read = await rowsOf(await aWidget(), falcon);

      const dashboard = (await listOf(await aWidget())).workspaces[0]!.dashboards.find((d) =>
        d.panels.some((p) => p.id === falcon),
      )!;
      expect(read.groups[0]!.rows).toEqual([
        {
          itemId: expect.any(String),
          label: 'Send the forecast',
          priority: 'high',
          dueDate: '2026-10-21',
          places: [`${dashboard.name} ▸ Admin`],
        },
      ]);
    });
  });

  describe('a Panel that does not exist answers not found', () => {
    it('answers one deleted since the widget picked it, one that never existed and a malformed one in the same words', async () => {
      const token = await aWidget();
      const gone = await aPanel('Gone');
      await sent('delete_panel', { dashboardId: DASHBOARD_ID, panelId: gone });

      const answers = await Promise.all(
        [gone, nextId(), 'not-a-panel', '%E0%A4%A', 'a%2Fb'].map(async (id) => {
          const answer = await SELF.fetch(`${PANELS}/${id}?date=${FAR_AHEAD}`, { headers: { authorization: `Bearer ${token}` } });
          return [answer.status, await answer.text()];
        }),
      );

      expect(new Set(answers.map((a) => JSON.stringify(a)))).toEqual(new Set([JSON.stringify([404, '{"error":"not found"}'])]));
    });

    it('answers another person’s Panel exactly as it answers one that never existed', async () => {
      const theirs = await aPanel('Theirs', 'items', OTHER_USER_ID);
      const token = await aWidget(USER_ID);

      const theirAnswer = await readPanel(token, theirs);
      const nobodys = await readPanel(token, nextId());

      expect([theirAnswer.status, await theirAnswer.text()]).toEqual([nobodys.status, await nobodys.text()]);
      expect(theirAnswer.status).toBe(404);
    });

    it('answers a Panel of text as not found too, which holds no Items to read', async () => {
      const notes = await aPanel('Notes', 'text');

      expect((await readPanel(await aWidget(), notes)).status).toBe(404);
    });

    it.each([
      { situation: 'the root of the apps address', path: '/apps' },
      { situation: 'a version the app does not hold', path: '/apps/v2/panels' },
      { situation: 'an address only like the list’s', path: '/apps/v1/panelsandmore' },
    ])('answers $situation as not found, though the token is good for /apps', async ({ path }) => {
      const answer = await SELF.fetch(`${ORIGIN}${path}`, { headers: { authorization: `Bearer ${await aWidget()}` } });

      expect([answer.status, await answer.text()]).toEqual([404, '{"error":"not found"}']);
    });

    it('answers anything but a GET with the one method a read is asked for', async () => {
      const answer = await SELF.fetch(PANELS, { method: 'POST', headers: { authorization: `Bearer ${await aWidget()}` } });

      expect(answer.status).toBe(405);
      expect(answer.headers.get('allow')).toBe('GET');
    });

    it.each([
      { situation: 'a day that is not a day', date: '2026-02-30' },
      { situation: 'a word', date: 'tomorrow' },
      { situation: 'no day at all', date: '' },
    ])('refuses $situation as an invalid date, rather than reading the Panel on this Worker’s own', async ({ date }) => {
      const panel = await aPanel('Falcon');

      const answer = await SELF.fetch(`${PANELS}/${panel}${date === '' ? '' : `?date=${date}`}`, {
        headers: { authorization: `Bearer ${await aWidget()}` },
      });

      expect(answer.status).toBe(400);
      expect(((await answer.json()) as { error: string }).error).toContain('date');
    });
  });

  describe('the answer keeps the shape installed widgets read', () => {
    /**
     * The scenario every sample file describes: a Filter panel grouped by Panel
     * over two Panels of a Dashboard, one Item on both, one on Falcon alone,
     * and a Panel of items on its own.
     */
    async function theScenario() {
      const dashboardId = nextId();
      await sent('add_dashboard', { dashboardId, panelId: nextId(), name: 'Day to day' });
      const [admin, falcon, gathers] = [nextId(), nextId(), nextId()];
      await sent('add_panel', { dashboardId, panelId: admin, name: 'Admin', kind: 'items' });
      await sent('add_panel', { dashboardId, panelId: falcon, name: 'Falcon', kind: 'items' });
      await sent('add_panel', { dashboardId, panelId: gathers, name: 'This week', kind: 'filter' });
      await sent('set_panel_filter', {
        dashboardId,
        panelId: gathers,
        rows: [[{ field: 'dashboard', values: [dashboardId] }]],
        groupBy: 'panel',
      });
      await anItem('Send the Q4 forecast to Sander', { priority: 'high', dueDate: '2026-10-21', on: [admin, falcon] });
      await anItem('Renew the domain', { on: [falcon] });
      return { admin, falcon, gathers };
    }

    it('keeps every field the samples have, with the same names and kinds', async () => {
      const { falcon, gathers } = await theScenario();
      const token = await aWidget();

      const filter = await readPanel(token, gathers, '2026-10-23');
      const flat = await readPanel(token, falcon, '2026-10-23');
      const list = await SELF.fetch(PANELS, { headers: { authorization: `Bearer ${token}` } });

      expect(satisfiesSample(filterSample, await filter.json())).toEqual([]);
      expect(satisfiesSample(flatSample, await flat.json())).toEqual([]);
      expect(satisfiesSample(listSample, await list.json())).toEqual([]);
    });

    it('still matches once a field is added to the answer, at any level', async () => {
      const { gathers } = await theScenario();
      const answer = (await (await readPanel(await aWidget(), gathers, '2026-10-23')).json()) as Read;

      const grown = {
        ...answer,
        added: 'at the top',
        workspace: { ...answer.workspace, also: 1 },
        groups: answer.groups.map((group) => ({
          ...group,
          note: 'on a group',
          rows: group.rows.map((row) => ({ ...row, extra: ['on a row'] })),
        })),
      };

      expect(satisfiesSample(filterSample, grown)).toEqual([]);
    });
  });
});
