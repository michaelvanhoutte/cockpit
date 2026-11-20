import { afterEach, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { applyD1Migrations, env, runInDurableObject } from 'cloudflare:test';
import { filingsThatFile, itemsInTheInbox, type WorkspaceSnapshot } from '@cockpit/shared';
import { createAccountDb } from '../../../src/accounts/client.js';
import { childRowsOfTheRead, filingsOfTheRead } from '../../../src/accounts/repo.js';
import { finishedKeptAfter } from '../../../src/domain/workspace-read.js';
import {
  ACCOUNT_NAME,
  DASHBOARD_ID,
  WORKSPACE_ID,
  asUser,
  inTheStore,
  seedRegister,
  startFromEmpty,
  storeNamed,
  withoutTheGuide,
} from '../seed.js';
import { ORIGIN, connected, mcp } from './connected-apps.support.js';

/**
 * Integration level, through the real Worker: "Brainstorming: an Item can't
 * hold other Items" (issue 1825) and "Brainstorming: a Panel is an Item nobody
 * can open" (issue 1846). Where an Item sits is a row in the account's
 * own store, and the Workspace's read, the store's own Inbox and `find_items`
 * are three separate queries over it, so each holds only against a real one.
 * The browser's half of the Inbox rule is proved at L1
 * (packages/shared/tests/unit/domain/filing.test.ts); the copy step that
 * brings over an older Worker's filings, against an aged store
 * (tests/integration/accounts/aged-store.test.ts).
 */

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
  await withoutTheGuide();
});

afterEach(() => {
  vi.useRealTimers();
});

let seq = 0;
function nextId(): string {
  seq += 1;
  return `018f0000-0000-7000-8000-${String(seq).padStart(12, '0')}`;
}

/** Now, by the clock the store reads, less as many days as given. */
const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString(); // clock-ok: the Workspace's read keeps a day by the store's own clock

async function send(command: string, body: Record<string, unknown>, issuedAt = daysAgo(0)) {
  return asUser(`${ORIGIN}/v1/commands/${command}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ commandId: nextId(), issuedAt, workspaceId: WORKSPACE_ID, ...body }),
  });
}

async function anItem(message: string, issuedAt = daysAgo(0)): Promise<string> {
  const itemId = nextId();
  expect((await send('capture_item', { itemId, message }, issuedAt)).status).toBe(200);
  return itemId;
}

async function aPanel(name: string): Promise<string> {
  const panelId = nextId();
  expect((await send('add_panel', { dashboardId: DASHBOARD_ID, panelId, name, kind: 'items' })).status).toBe(200);
  return panelId;
}

async function putInside(parentId: string, ...childIds: string[]) {
  return send('add_children', { parentId, childIds });
}

async function snapshot(): Promise<WorkspaceSnapshot> {
  const res = await asUser(`${ORIGIN}/v1/workspaces/${WORKSPACE_ID}/snapshot`);
  expect(res.status).toBe(200);
  return (await res.json()) as WorkspaceSnapshot;
}

/** The Inbox the app draws, from the Workspace's read. */
async function inTheAppsInbox(itemId: string): Promise<boolean> {
  const read = await snapshot();
  return itemsInTheInbox(read.items, filingsThatFile(read.filings, read.panels), read.children ?? []).some(
    (item) => item.id === itemId,
  );
}

/** The Inbox the store reads for itself, which a filing re-proposes the rest of. */
async function inTheStoresInbox(itemId: string): Promise<boolean> {
  const answer = await storeNamed(ACCOUNT_NAME).unfiledItemsInWorkspace(ACCOUNT_NAME, WORKSPACE_ID);
  if (answer.status !== 'ok') throw new Error(JSON.stringify(answer));
  return answer.value.some((item) => item.id === itemId);
}

/** Where a connected app is told an Item is. */
async function whereAnAppSees(token: string, text: string): Promise<string> {
  const answer = await mcp(token, 'tools/call', { name: 'find_items', arguments: { text } });
  const { result } = (await answer.json()) as { result: { content: { text: string }[] } };
  return /^Where: (.*)$/m.exec(result.content[0]!.text)?.[1] ?? '';
}

/** What is filed on a Panel, written the way only a filing is: the Panel's own filings and nothing under its Item. */
async function filedOnlyOnThePanel(panelId: string, itemId: string, position: number): Promise<void> {
  await inTheStore((sql) =>
    sql.exec(
      'INSERT INTO panel_items (tenant_id, panel_id, item_id, position, created_at) VALUES (?, ?, ?, ?, ?)',
      ACCOUNT_NAME,
      panelId,
      itemId,
      position,
      daysAgo(0),
    ),
  );
}

/** A row under a Panel's own Item with no filing beside it: what only the release before reads (issue 1846). */
async function keptOnlyUnderThePanel(panelId: string, itemId: string, position: number): Promise<void> {
  await inTheStore((sql) =>
    sql.exec(
      `INSERT INTO item_children (tenant_id, parent_id, child_id, position, created_at)
       VALUES (?, (SELECT item_id FROM panels WHERE id = ?), ?, ?, ?)`,
      ACCOUNT_NAME,
      panelId,
      itemId,
      position,
      daysAgo(0),
    ),
  );
}

async function fileOn(panelId: string, itemId: string) {
  return send('move_item_to_panel', { itemId, panelId, order: [itemId] });
}

describe('Inbox', () => {
  /**
   * "Brainstorming: a Panel is an Item nobody can open" (issue 1846): filed on
   * a Panel is read from the Panel's filings, inside an Item from the rows of
   * Items alone. Every filing still writes a row under the Panel's own Item for
   * the release before, so the last two cases, which hold one of the pair
   * without the other, are written into the store directly.
   */
  describe('the Inbox holds exactly the open Items filed on no live Panel and inside no live Item, wherever it is read', () => {
    it.each([
      {
        situation: 'filed on a live Panel',
        arrange: async (itemId: string) => expect((await fileOn(await aPanel('Scenes'), itemId)).status).toBe(200),
        inTheInbox: false,
        where: /▸ Scenes$/,
      },
      {
        situation: 'filed on a deleted Panel only',
        arrange: async (itemId: string) => {
          const panelId = await aPanel('Scenes');
          expect((await fileOn(panelId, itemId)).status).toBe(200);
          expect((await send('delete_panel', { panelId })).status).toBe(200);
        },
        inTheInbox: true,
        where: /^Workspace 1 ▸ Inbox$/,
      },
      {
        situation: 'inside a live Item',
        arrange: async (itemId: string) => expect((await putInside(await anItem('Chapter 3'), itemId)).status).toBe(200),
        inTheInbox: false,
        where: /^Workspace 1 ▸ inside Chapter 3$/,
      },
      {
        situation: 'inside a dismissed Item only',
        arrange: async (itemId: string) => {
          const chapter = await anItem('Chapter 3');
          expect((await putInside(chapter, itemId)).status).toBe(200);
          expect((await send('set_dismissed', { itemId: chapter, dismissed: true })).status).toBe(200);
        },
        inTheInbox: true,
        where: /^Workspace 1 ▸ Inbox$/,
      },
      {
        situation: 'filed on a live Panel the release before never recorded',
        arrange: async (itemId: string) => filedOnlyOnThePanel(await aPanel('Scenes'), itemId, 0),
        inTheInbox: false,
        where: /▸ Scenes$/,
      },
      {
        situation: 'recorded under a live Panel by the release before, but filed on none',
        arrange: async (itemId: string) => keptOnlyUnderThePanel(await aPanel('Scenes'), itemId, 0),
        inTheInbox: true,
        where: /^Workspace 1 ▸ Inbox$/,
      },
    ])('$situation', async ({ arrange, inTheInbox, where }) => {
      const { token } = await connected();
      const storm = await anItem('Storm scene');

      await arrange(storm);

      expect(await inTheAppsInbox(storm)).toBe(inTheInbox);
      expect(await inTheStoresInbox(storm)).toBe(inTheInbox);
      expect(await whereAnAppSees(token, 'storm')).toMatch(where);
    });

    it('never holds a Panel’s own Item', async () => {
      const { token } = await connected();
      const panelId = await aPanel('Characters');

      const read = await snapshot();
      expect(read.items.some((item) => item.id === panelId)).toBe(false);
      expect(await inTheStoresInbox(panelId)).toBe(false);
      expect(await whereAnAppSees(token, 'characters')).toBe('');
    });

    it('leaves out an Item finished with no parent', async () => {
      const done = await anItem('Book the ferry');
      expect((await send('set_done', { itemId: done, done: true })).status).toBe(200);

      expect(await inTheAppsInbox(done)).toBe(false);
      expect(await inTheStoresInbox(done)).toBe(false);
    });
  });
});

describe('Panels', () => {
  /**
   * A Panel holds what is filed on it and is never an Item ("Brainstorming: a
   * Panel is an Item nobody can open", issue 1846). The rows under its own Item
   * are still written for the release before, so a case holding one of the
   * pair without the other is written into the store directly.
   */
  describe('a Panel shows what is filed on it, never what is recorded under it for the release before', () => {
    it.each([
      { situation: 'filed on it, never recorded under it', write: filedOnlyOnThePanel, onThePanel: true },
      { situation: 'recorded under it, never filed on it', write: keptOnlyUnderThePanel, onThePanel: false },
    ])('an Item $situation', async ({ write, onThePanel }) => {
      const panelId = await aPanel('Scenes');
      const storm = await anItem('Storm scene');

      await write(panelId, storm, 0);

      const read = await snapshot();
      expect(read.filings.some((filing) => filing.panelId === panelId && filing.itemId === storm)).toBe(onThePanel);
      expect((read.children ?? []).some((row) => row.childId === storm)).toBe(false);
    });

    it('keeps the order its filings hold, which a move’s order is checked against', async () => {
      const panelId = await aPanel('Scenes');
      const [storm, ferry, kept] = [await anItem('Storm scene'), await anItem('Ferry scene'), await anItem('Kept scene')];
      await filedOnlyOnThePanel(panelId, storm, 1);
      await filedOnlyOnThePanel(panelId, ferry, 0);
      // Recorded under the Panel alone, first in that order: a move need not name it.
      await keptOnlyUnderThePanel(panelId, kept, 0);
      const order = async () => (await snapshot()).filings.filter((filing) => filing.panelId === panelId).map((filing) => filing.itemId);
      expect(await order()).toEqual([ferry, storm]);

      const opening = await anItem('Opening scene');
      expect((await send('move_item_to_panel', { itemId: opening, panelId, order: [opening, ferry, storm] })).status).toBe(200);

      expect(await order()).toEqual([opening, ferry, storm]);
    });
  });

  describe('a Panel is never a parent: an Item filed on one has only Items as parents', () => {
    it('sends no parent row for the Panel, and an Item holding it is its one parent', async () => {
      const { token } = await connected();
      const panelId = await aPanel('Scenes');
      const chapter = await anItem('Chapter 3');
      const storm = await anItem('Storm scene');
      expect((await fileOn(panelId, storm)).status).toBe(200);
      expect((await send('move_item_to_panel', { itemId: chapter, panelId, order: [chapter, storm] })).status).toBe(200);

      expect((await putInside(chapter, storm)).status).toBe(200);

      const read = await snapshot();
      expect((read.children ?? []).filter((row) => row.childId === storm).map((row) => row.parentId)).toEqual([chapter]);
      expect((read.children ?? []).some((row) => row.parentId === panelId)).toBe(false);
      expect(await whereAnAppSees(token, 'storm')).toBe('Workspace 1 ▸ Dashboard 1 ▸ Scenes; Workspace 1 ▸ inside Chapter 3');
    });
  });

  describe('an Item can have several parents, and never becomes its own ancestor', () => {
    it('lists a child of two parents under both', async () => {
      const people = await anItem('People');
      const act = await anItem('Act 2');
      const mentor = await anItem('Mentor');

      expect((await putInside(people, mentor)).status).toBe(200);
      expect((await putInside(act, mentor)).status).toBe(200);

      const rows = (await snapshot()).children ?? [];
      expect(rows.filter((row) => row.childId === mentor).map((row) => row.parentId).sort()).toEqual([act, people].sort());
    });

    it.each([
      { situation: 'A in B, then B into A', depth: 1 },
      { situation: 'A in B in C, then C into A', depth: 2 },
    ])('refuses $situation, and changes nothing', async ({ depth }) => {
      const chain = [await anItem('A')];
      for (let n = 0; n < depth; n += 1) {
        const above = await anItem(`Above ${n}`);
        expect((await putInside(above, chain.at(-1)!)).status).toBe(200);
        chain.push(above);
      }
      const before = (await snapshot()).children;

      const refused = await putInside(chain[0]!, chain.at(-1)!);

      expect(refused.status).toBe(400);
      expect((await snapshot()).children).toEqual(before);
    });

    it.each([
      { situation: 'into a dismissed parent', dismissed: 'parent' as const },
      { situation: 'a dismissed child', dismissed: 'child' as const },
    ])('refuses putting $situation, as no Item is there', async ({ dismissed }) => {
      const chapter = await anItem('Chapter 3');
      const storm = await anItem('Storm scene');
      expect((await send('set_dismissed', { itemId: dismissed === 'parent' ? chapter : storm, dismissed: true })).status).toBe(200);

      expect((await putInside(chapter, storm)).status).toBe(404);
    });
  });

  describe('a parent’s count and its done count stay true, whatever the Workspace’s read leaves out', () => {
    it('still counts a child finished 40 days ago as done', async () => {
      const chapter = await anItem('Chapter 3');
      const old = await anItem('An old scene', daysAgo(41));
      const open = await anItem('A new scene');
      expect((await putInside(chapter, old, open)).status).toBe(200);

      expect((await send('set_done', { itemId: old, done: true }, daysAgo(40))).status).toBe(200);

      const read = await snapshot();
      expect(read.items.some((item) => item.id === old)).toBe(false);
      expect(read.items.find((item) => item.id === chapter)).toMatchObject({ childrenCount: 2, childrenDone: 1 });
    });

    it('counts out a child taken out', async () => {
      const chapter = await anItem('Chapter 3');
      const storm = await anItem('Storm scene');
      const ferry = await anItem('Ferry scene');
      expect((await putInside(chapter, storm, ferry)).status).toBe(200);

      expect((await send('remove_child', { parentId: chapter, childId: storm })).status).toBe(200);

      const read = await snapshot();
      expect(read.items.find((item) => item.id === chapter)).toMatchObject({ childrenCount: 1, childrenDone: 0 });
      expect((read.children ?? []).filter((row) => row.parentId === chapter).map((row) => row.childId)).toEqual([ferry]);
    });

    it('counts out and sends no row for a child dismissed', async () => {
      const chapter = await anItem('Chapter 3');
      const storm = await anItem('Storm scene');
      const ferry = await anItem('Ferry scene');
      expect((await putInside(chapter, storm, ferry)).status).toBe(200);

      expect((await send('set_dismissed', { itemId: storm, dismissed: true })).status).toBe(200);

      const read = await snapshot();
      expect(read.items.find((item) => item.id === chapter)).toMatchObject({ childrenCount: 1, childrenDone: 0 });
      expect((read.children ?? []).filter((row) => row.parentId === chapter).map((row) => row.childId)).toEqual([ferry]);
    });
  });

  describe('the Workspace’s read carries where an Item sits only for the Items it reads', () => {
    it('holds the same rows with 1,000 finished children filed on a Panel as with none', async () => {
      const panelId = await aPanel('Scenes');
      const chapter = await anItem('Chapter 3');
      const storm = await anItem('Storm scene');
      expect((await putInside(chapter, storm)).status).toBe(200);
      const before = await snapshot();

      const finished = daysAgo(40);
      await inTheStore((sql) => {
        for (let n = 0; n < 1000; n += 1) {
          const id = `018f0000-0000-7000-9000-${String(n).padStart(12, '0')}`;
          sql.exec(
            `INSERT INTO items (id, tenant_id, workspace_id, source, title, status, unseen, created_at, updated_at, completed_at)
             VALUES (?, ?, ?, 'internal', ?, 'to_process', 0, ?, ?, ?)`,
            id,
            ACCOUNT_NAME,
            WORKSPACE_ID,
            `Scene ${n}`,
            finished,
            finished,
            finished,
          );
          sql.exec(
            'INSERT INTO panel_items (tenant_id, panel_id, item_id, position, created_at) VALUES (?, ?, ?, ?, ?)',
            ACCOUNT_NAME,
            panelId,
            id,
            n,
            finished,
          );
        }
      });

      const after = await snapshot();
      expect(after.filings).toEqual(before.filings);
      expect(after.children).toEqual(before.children);
    });

    it.each([
      { situation: 'what is filed on a Panel', query: filingsOfTheRead, index: /panel_items USING INDEX panel_items_tenant_item/ },
      { situation: 'what an Item holds', query: childRowsOfTheRead, index: /item_children USING INDEX item_children_tenant_child/ },
    ])('reads $situation by the Items read, through an index on the Item', async ({ query, index }) => {
      await inTheStore(() => undefined);
      const plan = await runInDurableObject(storeNamed(ACCOUNT_NAME), (_instance, state) => {
        const { sql, params } = query(createAccountDb(state.storage), ACCOUNT_NAME, WORKSPACE_ID, {
          finishedAfter: finishedKeptAfter(new Date()), // clock-ok: the plan is the same whatever the moment
        }).toSQL();
        return state.storage.sql
          .exec<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, ...params)
          .toArray()
          .map((row) => row.detail);
      });

      expect(plan).toContainEqual(expect.stringMatching(index));
    });
  });
});
