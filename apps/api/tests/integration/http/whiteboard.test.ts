import { beforeEach, describe, expect, inject, it } from 'vitest';
import { applyD1Migrations, env, runInDurableObject } from 'cloudflare:test';
import { filingsThatFile, itemsInTheInbox, type WorkspaceSnapshot } from '@cockpit/shared';
import { SWATCHES, type OnWhiteboardsRefusal, type Whiteboards } from '@cockpit/shared/board';
import { createAccountDb } from '../../../src/accounts/client.js';
import { boxesOfTheBoards, cardsOfItems, cardsOfTheBoards } from '../../../src/accounts/board.js';
import { ACCOUNT_NAME, DASHBOARD_ID, WORKSPACE_ID, asUser, inTheStore, seedRegister, startFromEmpty, storeNamed, withoutTheGuide } from '../seed.js';
import { ORIGIN } from './connected-apps.support.js';

/**
 * Integration level, through the real Worker: "Brainstorming: give every
 * Dashboard a whiteboard of its own" (issue 1829). A board is rows in the
 * account's own store, the Inbox rule it keeps is the store's SQL, and what the
 * Workspace's read carries is a query over both, so each holds only against a
 * real one. The swatches' contrast is proved at L1
 * (apps/web/tests/unit/appearanceTokens.test.ts).
 */

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
  await withoutTheGuide();
});

let seq = 0;
function nextId(): string {
  seq += 1;
  return `018f0000-0000-7000-8000-${String(seq).padStart(12, '0')}`;
}

const NOW = '2026-11-20T10:00:00.000Z';
let tick = 0;
/** A later moment for each change, so no two stamps are the same. */
const later = () => new Date(Date.parse(NOW) + ++tick * 1000).toISOString();

async function send(command: string, body: Record<string, unknown>) {
  return asUser(`${ORIGIN}/v1/commands/${command}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ commandId: nextId(), issuedAt: later(), workspaceId: WORKSPACE_ID, ...body }),
  });
}

async function ok(command: string, body: Record<string, unknown>): Promise<{ applied: boolean }> {
  const res = await send(command, body);
  expect(res.status, `${command}: ${await res.clone().text()}`).toBe(200);
  return (await res.json()) as { applied: boolean };
}

async function anItem(message: string): Promise<string> {
  const itemId = nextId();
  await ok('capture_item', { itemId, message });
  return itemId;
}

async function aPanel(name: string, dashboardId = DASHBOARD_ID): Promise<string> {
  const panelId = nextId();
  await ok('add_panel', { dashboardId, panelId, name, kind: 'items' });
  return panelId;
}

async function aDashboard(name: string): Promise<string> {
  const dashboardId = nextId();
  await ok('add_dashboard', { dashboardId, panelId: nextId(), name });
  return dashboardId;
}

/** An Item filed on a Panel of its own, alone there. */
async function aFiledItem(message: string, panelId?: string): Promise<{ itemId: string; panelId: string }> {
  const panel = panelId ?? (await aPanel(`${message} panel`));
  const itemId = await anItem(message);
  const held = (await snapshot()).filings.filter((filing) => filing.panelId === panel).map((filing) => filing.itemId);
  await ok('move_item_to_panel', { itemId, panelId: panel, order: [itemId, ...held] });
  return { itemId, panelId: panel };
}

async function place(itemId: string, dashboardId = DASHBOARD_ID, boxId: string | null = null, at = { x: 10, y: 20 }) {
  const cardId = nextId();
  const res = await send('place_card', { cardId, dashboardId, itemId, boxId, ...at });
  return { cardId, res };
}

async function aCard(itemId: string, dashboardId = DASHBOARD_ID, boxId: string | null = null): Promise<string> {
  const { cardId, res } = await place(itemId, dashboardId, boxId);
  expect(res.status, await res.clone().text()).toBe(200);
  return cardId;
}

async function aBox(label: string, parentBoxId: string | null = null, dashboardId = DASHBOARD_ID): Promise<string> {
  const boxId = nextId();
  await ok('draw_box', { boxId, dashboardId, parentBoxId, label, colour: null, x: 0, y: 0, w: 400, h: 300 });
  return boxId;
}

async function snapshot(): Promise<WorkspaceSnapshot & { whiteboards: Whiteboards }> {
  const res = await asUser(`${ORIGIN}/v1/workspaces/${WORKSPACE_ID}/snapshot`);
  expect(res.status).toBe(200);
  return (await res.json()) as WorkspaceSnapshot & { whiteboards: Whiteboards };
}

const cardsOn = async (dashboardId = DASHBOARD_ID) => (await snapshot()).whiteboards.cards.filter((card) => card.dashboardId === dashboardId);
const cardsOf = async (itemId: string) => (await snapshot()).whiteboards.cards.filter((card) => card.itemId === itemId);

async function inTheInbox(itemId: string): Promise<boolean> {
  const read = await snapshot();
  return itemsInTheInbox(read.items, filingsThatFile(read.filings, read.panels), read.children ?? []).some((item) => item.id === itemId);
}

async function rowsIn(table: 'board_cards' | 'board_boxes' | 'items'): Promise<number> {
  return inTheStore((sql) => sql.exec<{ n: number }>(`SELECT count(*) AS n FROM ${table}`).one().n);
}

describe('Whiteboard', () => {
  describe('a card is one Item placed on one Dashboard’s board, at most once, and placing neither files nor is filing', () => {
    it('places a Panel’s row as one card, leaving where it is filed as it was', async () => {
      const { itemId, panelId } = await aFiledItem('Storm scene');
      const filedBefore = (await snapshot()).filings;
      const cardId = await aCard(itemId);

      const read = await snapshot();
      expect(read.whiteboards.cards).toEqual([{ id: cardId, dashboardId: DASHBOARD_ID, itemId, boxId: null, x: 10, y: 20 }]);
      expect(read.filings).toEqual(filedBefore);
      expect(read.filings.some((filing) => filing.panelId === panelId && filing.itemId === itemId)).toBe(true);
    });

    it('places a child of a parent, filed nowhere itself', async () => {
      const { itemId: parentId } = await aFiledItem('Chapter 3');
      const childId = await anItem('Storm scene');
      await ok('add_children', { parentId, childIds: [childId] });
      await aCard(childId);
      expect((await cardsOf(childId)).length).toBe(1);
    });

    it.each([
      { situation: 'moved on open space', box: false },
      { situation: 'moved into a box', box: true },
    ])('stores where a card is $situation', async ({ box }) => {
      const { itemId } = await aFiledItem('Storm scene');
      const cardId = await aCard(itemId);
      const boxId = box ? await aBox('People') : null;
      await ok('move_card', { cardId, boxId, x: 55.5, y: -12 });
      expect(await cardsOf(itemId)).toEqual([{ id: cardId, dashboardId: DASHBOARD_ID, itemId, boxId, x: 55.5, y: -12 }]);
    });

    it('keeps one card when the same Item is placed on one board twice', async () => {
      const { itemId } = await aFiledItem('Storm scene');
      const first = await aCard(itemId);
      const { res } = await place(itemId);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { applied: boolean }).applied).toBe(false);
      expect((await cardsOf(itemId)).map((card) => card.id)).toEqual([first]);
    });

    it('gives the same Item one card on each of two Dashboards', async () => {
      const { itemId } = await aFiledItem('Storm scene');
      const other = await aDashboard('Plot');
      await aCard(itemId);
      await aCard(itemId, other);
      expect((await cardsOf(itemId)).map((card) => card.dashboardId).sort()).toEqual([DASHBOARD_ID, other].sort());
    });

    it('reads a card’s Item finished 40 days ago, which the read otherwise leaves out', async () => {
      const { itemId } = await aFiledItem('Storm scene');
      const leftAlone = (await aFiledItem('Old note')).itemId;
      await aCard(itemId);
      const fortyDaysAgo = new Date(Date.parse(NOW) - 40 * 24 * 60 * 60 * 1000).toISOString();
      await inTheStore((sql) => sql.exec('UPDATE items SET completed_at = ? WHERE id IN (?, ?)', fortyDaysAgo, itemId, leftAlone));

      const read = await snapshot();
      expect(read.items.find((item) => item.id === itemId)?.completedAt).toBe(fortyDaysAgo);
      expect(read.items.some((item) => item.id === leftAlone)).toBe(false);
      expect(read.finishedItemsLeftOut).toBe(1);
      expect(read.whiteboards.cards.map((card) => card.itemId)).toEqual([itemId]);
    });

    it('puts no card on any board for an Item filed on a Panel', async () => {
      await aFiledItem('Storm scene');
      expect((await snapshot()).whiteboards.cards).toEqual([]);
    });
  });

  describe('a box is drawn on the board alone: it can be empty, nest, collapse, and be deleted and brought back', () => {
    it('draws a named box on open space, kept while empty', async () => {
      const boxId = await aBox('People');
      expect((await snapshot()).whiteboards.boxes).toEqual([
        { id: boxId, dashboardId: DASHBOARD_ID, parentBoxId: null, label: 'People', colour: null, x: 0, y: 0, w: 400, h: 300, collapsed: false },
      ]);
    });

    it('draws a box inside another', async () => {
      const outer = await aBox('Act one');
      const inner = await aBox('People', outer);
      expect((await snapshot()).whiteboards.boxes.find((box) => box.id === inner)?.parentBoxId).toBe(outer);
    });

    it.each([
      { situation: 'collapsed', command: 'set_box_collapsed', body: { collapsed: true }, expected: { collapsed: true } },
      { situation: 'renamed', command: 'rename_box', body: { label: 'Places' }, expected: { label: 'Places' } },
      { situation: 'resized', command: 'resize_box', body: { x: -5, y: 6, w: 120, h: 80 }, expected: { x: -5, y: 6, w: 120, h: 80 } },
      { situation: 'moved', command: 'move_box', body: { parentBoxId: null, x: 300, y: 40 }, expected: { x: 300, y: 40 } },
    ])('stores a box $situation', async ({ command, body, expected }) => {
      const boxId = await aBox('People');
      await ok(command, { boxId, ...body });
      expect((await snapshot()).whiteboards.boxes[0]).toMatchObject(expected);
    });

    it.each([
      { situation: 'into itself', into: (outer: string, _inner: string) => outer },
      { situation: 'into a box it holds', into: (_outer: string, inner: string) => inner },
    ])('refuses a box moved $situation', async ({ into }) => {
      const outer = await aBox('Act one');
      const inner = await aBox('People', outer);
      const res = await send('move_box', { boxId: outer, parentBoxId: into(outer, inner), x: 0, y: 0 });
      expect(res.status).toBe(400);
      expect((await snapshot()).whiteboards.boxes.find((box) => box.id === outer)?.parentBoxId).toBeNull();
    });

    it('takes a deleted box, the box inside it and its card off the board, the Item untouched, and Undo brings all of it back', async () => {
      const { itemId, panelId } = await aFiledItem('Storm scene');
      const outer = await aBox('Act one');
      const inner = await aBox('People', outer);
      const cardId = await aCard(itemId, DASHBOARD_ID, inner);
      const before = await snapshot();

      await ok('delete_box', { boxId: outer });
      const deleted = await snapshot();
      expect(deleted.whiteboards.boxes).toEqual([]);
      expect(deleted.whiteboards.cards).toEqual([]);
      expect(deleted.items.find((item) => item.id === itemId)).toEqual(before.items.find((item) => item.id === itemId));
      expect(deleted.filings.some((filing) => filing.itemId === itemId && filing.panelId === panelId)).toBe(true);

      await ok('restore_box', { boxId: outer });
      const back = await snapshot();
      expect(back.whiteboards.boxes.map((box) => box.id).sort()).toEqual([outer, inner].sort());
      expect(back.whiteboards.cards).toEqual([{ id: cardId, dashboardId: DASHBOARD_ID, itemId, boxId: inner, x: 10, y: 20 }]);
    });
  });

  describe('a card or box keeps its place on the board when the box it was in is gone', () => {
    it.each([
      { situation: 'a card put back', box: false },
      { situation: 'a box brought back', box: true },
    ])('$situation lands where it was drawn', async ({ box }) => {
      const outer = nextId();
      await ok('draw_box', { boxId: outer, dashboardId: DASHBOARD_ID, parentBoxId: null, label: 'Act one', colour: null, x: 5000, y: 3000, w: 900, h: 900 });
      const inner = nextId();
      await ok('draw_box', { boxId: inner, dashboardId: DASHBOARD_ID, parentBoxId: outer, label: 'People', colour: null, x: 100, y: 50, w: 400, h: 300 });
      if (box) {
        await ok('delete_box', { boxId: inner });
        await ok('delete_box', { boxId: outer });
        await ok('restore_box', { boxId: inner });
        expect((await snapshot()).whiteboards.boxes).toEqual([expect.objectContaining({ id: inner, parentBoxId: null, x: 5100, y: 3050 })]);
      } else {
        const { itemId } = await aFiledItem('Storm scene');
        const cardId = await aCard(itemId, DASHBOARD_ID, inner);
        await ok('take_card_off', { cardId });
        await ok('delete_box', { boxId: outer });
        await ok('put_cards_back', { cardIds: [cardId] });
        expect(await cardsOf(itemId)).toEqual([{ id: cardId, dashboardId: DASHBOARD_ID, itemId, boxId: null, x: 5110, y: 3070 }]);
      }
    });
  });

  describe('the Workspace’s read finds a board’s boxes and cards, and an Item’s cards, through their indexes', () => {
    it.each([
      { situation: 'a board’s boxes', query: boxesOfTheBoards, index: /board_boxes USING INDEX board_boxes_tenant_dashboard/ },
      { situation: 'a board’s cards', query: cardsOfTheBoards, index: /board_cards USING INDEX board_cards_tenant_dashboard/ },
      {
        situation: 'the cards of one Item, for On whiteboards',
        query: (db: ReturnType<typeof createAccountDb>, tenantId: string) => cardsOfItems(db, tenantId, ['it-1']),
        index: /board_cards USING INDEX board_cards_tenant_item/,
      },
    ])('reads $situation', async ({ query, index }) => {
      await inTheStore(() => undefined);
      const plan = await runInDurableObject(storeNamed(ACCOUNT_NAME), (_instance, state) => {
        const { sql, params } = query(createAccountDb(state.storage), ACCOUNT_NAME, WORKSPACE_ID).toSQL();
        return state.storage.sql
          .exec<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, ...params)
          .toArray()
          .map((row) => row.detail);
      });
      expect(plan).toContainEqual(expect.stringMatching(index));
    });
  });

  describe('a board starts empty, holds no Panel, and is never an Item', () => {
    it('gives a new Dashboard no boxes and no cards, and draws its Panels alone', async () => {
      const dashboardId = await aDashboard('Plot');
      const { whiteboards } = await snapshot();
      expect(whiteboards.boxes.filter((box) => box.dashboardId === dashboardId)).toEqual([]);
      expect(whiteboards.cards.filter((card) => card.dashboardId === dashboardId)).toEqual([]);
      expect(whiteboards.layouts.some((layout) => layout.dashboardId === dashboardId)).toBe(false);
    });

    it('makes no Item to open, draw on or place on a board', async () => {
      const { itemId } = await aFiledItem('Storm scene');
      const items = await rowsIn('items');
      await aBox('People');
      await aCard(itemId);
      await snapshot();
      expect(await rowsIn('items')).toBe(items);
    });

    it('refuses a Panel placed as a card', async () => {
      const panelId = await aPanel('Characters');
      const { res } = await place(panelId);
      expect(res.status).toBe(404);
      expect(await rowsIn('board_cards')).toBe(0);
    });
  });

  describe('a Dashboard’s view and divider are kept per Dashboard', () => {
    it('keeps the view and divider chosen on one Dashboard, and nothing on another', async () => {
      const other = await aDashboard('Plot');
      await ok('set_dashboard_view', { dashboardId: DASHBOARD_ID, view: 'side' });
      await ok('set_dashboard_split', { dashboardId: DASHBOARD_ID, splitShare: 0.55 });
      const { layouts } = (await snapshot()).whiteboards;
      expect(layouts).toEqual([{ dashboardId: DASHBOARD_ID, view: 'side', splitShare: 0.55 }]);
      expect(layouts.some((layout) => layout.dashboardId === other)).toBe(false);
    });

    it.each([
      { situation: 'a view with no icon', command: 'set_dashboard_view', body: { view: 'mosaic' } },
      { situation: 'a divider past the edge', command: 'set_dashboard_split', body: { splitShare: 1.2 } },
    ])('refuses $situation', async ({ command, body }) => {
      expect((await send(command, { dashboardId: DASHBOARD_ID, ...body })).status).toBe(400);
      expect((await snapshot()).whiteboards.layouts).toEqual([]);
    });
  });

  describe('a box takes one of the eight colours or none', () => {
    it.each(SWATCHES.map((colour) => ({ colour })))('stores $colour', async ({ colour }) => {
      const boxId = await aBox('People');
      await ok('set_box_colour', { boxId, colour });
      expect((await snapshot()).whiteboards.boxes[0]?.colour).toBe(colour);
    });

    it('stores None', async () => {
      const boxId = await aBox('People');
      await ok('set_box_colour', { boxId, colour: 'rose' });
      await ok('set_box_colour', { boxId, colour: null });
      expect((await snapshot()).whiteboards.boxes[0]?.colour).toBeNull();
    });

    it.each([
      { situation: 'drawn in a colour that is no swatch', send: () => send('draw_box', { boxId: nextId(), dashboardId: DASHBOARD_ID, parentBoxId: null, label: 'People', colour: '#ff0000', x: 0, y: 0, w: 10, h: 10 }) },
      { situation: 'given a colour that is no swatch', send: async () => send('set_box_colour', { boxId: await aBox('People'), colour: 'magenta' }) },
    ])('refuses a box $situation', async ({ send: sending }) => {
      expect((await sending()).status).toBe(400);
      expect((await snapshot()).whiteboards.boxes.every((box) => box.colour === null)).toBe(true);
    });
  });

  describe('an Item in the Inbox can’t be placed', () => {
    it('refuses an Inbox Item, saying to file it or put it inside an Item first, and writes nothing', async () => {
      const itemId = await anItem('Loose thought');
      const { res } = await place(itemId);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('Loose thought is in the Inbox. File it on a Panel or put it inside an Item first.');
      expect(await rowsIn('board_cards')).toBe(0);
    });

    it('refuses a finished Item filed nowhere, saying to give it a place first', async () => {
      const itemId = await anItem('Loose thought');
      await ok('set_done', { itemId, done: true });
      const { res } = await place(itemId);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('Loose thought is on no Panel and inside no Item. File it on a Panel or put it inside an Item first.');
    });

    it('places the same Item once it is filed on a Panel', async () => {
      const itemId = await anItem('Loose thought');
      const panelId = await aPanel('Ideas');
      await ok('move_item_to_panel', { itemId, panelId, order: [itemId] });
      expect((await place(itemId)).res.status).toBe(200);
    });
  });

  describe('an Item in the Inbox is never on a whiteboard', () => {
    /** An Item with a card on each of two boards, and one way of sending it to the Inbox with its Undo. */
    const ways = [
      {
        situation: 'taken off its last Panel',
        arrange: async () => aFiledItem('Storm scene'),
        change: ({ itemId, panelId }: Placed) => ['remove_item_from_panel', { itemId, panelId }] as const,
        undo: ({ itemId, panelId }: Placed) => ['add_item_to_panel', { itemId, panelId, order: [itemId] }] as const,
      },
      {
        situation: 'moved to the Inbox',
        arrange: async () => aFiledItem('Storm scene'),
        change: ({ itemId }: Placed) => ['move_item_to_panel', { itemId, panelId: null, order: [] }] as const,
        undo: ({ itemId, panelId }: Placed) => ['move_item_to_panel', { itemId, panelId, order: [itemId] }] as const,
      },
      {
        situation: 'taken out of its last parent',
        arrange: async () => {
          const { itemId: parentId, panelId } = await aFiledItem('Chapter 3');
          const itemId = await anItem('Storm scene');
          await ok('add_children', { parentId, childIds: [itemId] });
          return { itemId, panelId, parentId };
        },
        change: ({ itemId, parentId }: Placed) => ['remove_child', { parentId, childId: itemId }] as const,
        undo: ({ itemId, parentId }: Placed) => ['add_children', { parentId, childIds: [itemId] }] as const,
      },
      {
        situation: 'left by the Item holding it, dismissed',
        arrange: async () => {
          const { itemId: parentId, panelId } = await aFiledItem('Chapter 3');
          const itemId = await anItem('Storm scene');
          await ok('add_children', { parentId, childIds: [itemId] });
          return { itemId, panelId, parentId };
        },
        change: ({ parentId }: Placed) => ['set_dismissed', { itemId: parentId, dismissed: true }] as const,
        undo: ({ parentId }: Placed) => ['set_dismissed', { itemId: parentId, dismissed: false }] as const,
      },
      {
        situation: 'left by its Panel, deleted',
        arrange: async () => aFiledItem('Storm scene'),
        change: ({ panelId }: Placed) => ['delete_panel', { panelId }] as const,
        undo: null,
      },
      {
        situation: 'left by its Panel’s Dashboard, deleted',
        arrange: async () => {
          const dashboardId = await aDashboard('Drafts');
          return { ...(await aFiledItem('Storm scene', await aPanel('Scenes', dashboardId))), dashboardId };
        },
        change: ({ dashboardId }: Placed) => ['delete_dashboard', { dashboardId }] as const,
        undo: null,
      },
    ];
    type Placed = { itemId: string; panelId: string; parentId?: string; dashboardId?: string };

    async function placedTwice(arrange: () => Promise<Placed>) {
      const placed = await arrange();
      const plot = await aDashboard('Plot');
      const cardIds = [await aCard(placed.itemId), await aCard(placed.itemId, plot)];
      return { placed, plot, cardIds };
    }

    describe.each(ways)('an Item with cards $situation', ({ arrange, change }) => {
      it('is refused without taking its cards off, naming the Item and each Dashboard, and nothing changes', async () => {
        const { placed, plot, cardIds } = await placedTwice(arrange);
        const before = await snapshot();
        const [command, body] = change(placed);

        const res = await send(command, body);
        expect(res.status).toBe(409);
        const refusal = (await res.json()) as OnWhiteboardsRefusal;
        expect(refusal.onWhiteboards).toEqual([
          {
            itemId: placed.itemId,
            title: 'Storm scene',
            cards: [
              { cardId: cardIds[0], dashboardId: DASHBOARD_ID, dashboardName: expect.any(String) },
              { cardId: cardIds[1], dashboardId: plot, dashboardName: 'Plot' },
            ],
          },
        ]);
        expect(refusal.error).toMatch(/^Storm scene is also on the whiteboard of .*, Plot\. Take it off there too\?$/);
        const after = await snapshot();
        expect(after.whiteboards).toEqual(before.whiteboards);
        expect(after.filings).toEqual(before.filings);
        expect(after.children).toEqual(before.children);
        expect(after.items).toEqual(before.items);
      });

      it('sends it to the Inbox taking its cards off every board, when asked to', async () => {
        const { placed } = await placedTwice(arrange);
        const [command, body] = change(placed);
        await ok(command, { ...body, takeCardsOff: true });
        expect(await inTheInbox(placed.itemId)).toBe(true);
        expect(await cardsOf(placed.itemId)).toEqual([]);
      });

    });

    describe.each(ways.filter((way) => way.undo !== null))('an Item with cards $situation', ({ arrange, change, undo }) => {
      it('is put back, its cards with it, by one Undo', async () => {
        const { placed, cardIds } = await placedTwice(arrange);
        const before = await snapshot();
        const [command, body] = change(placed);
        await ok(command, { ...body, takeCardsOff: true });

        const [undoing, undoBody] = undo!(placed);
        await ok(undoing, undoBody);
        await ok('put_cards_back', { cardIds });
        const back = await snapshot();
        expect(await inTheInbox(placed.itemId)).toBe(false);
        expect(back.whiteboards.cards).toEqual(before.whiteboards.cards);
      });
    });

    it('names every Item a change sends to the Inbox with its cards, once, for a selection of 3', async () => {
      const panelId = await aPanel('Scenes');
      const placed = [];
      for (const message of ['Storm scene', 'Harbour scene', 'Market scene']) {
        const { itemId } = await aFiledItem(message, panelId);
        await aCard(itemId);
        placed.push(itemId);
      }
      const res = await send('delete_panel', { panelId });
      expect(res.status).toBe(409);
      const refusal = (await res.json()) as OnWhiteboardsRefusal;
      expect(refusal.onWhiteboards.map((item) => item.itemId).sort()).toEqual([...placed].sort());
      expect(refusal.error).toBe('3 Items are also on whiteboards. Take them off there too?');
    });

    it.each([
      { situation: 'taken off a Panel while filed on another', other: 'panel' },
      { situation: 'taken off its last Panel while inside an Item', other: 'parent' },
    ])('keeps the cards of an Item $situation, asking nothing', async ({ other }) => {
      const { itemId, panelId } = await aFiledItem('Storm scene');
      if (other === 'panel') {
        await ok('add_item_to_panel', { itemId, panelId: await aPanel('Elsewhere'), order: [itemId] });
      } else {
        const { itemId: parentId } = await aFiledItem('Chapter 3');
        await ok('add_children', { parentId, childIds: [itemId] });
      }
      const cardId = await aCard(itemId);
      await ok('remove_item_from_panel', { itemId, panelId });
      expect((await cardsOf(itemId)).map((card) => card.id)).toEqual([cardId]);
    });

    it('asks nothing for an Item with no cards', async () => {
      const { itemId, panelId } = await aFiledItem('Storm scene');
      await ok('remove_item_from_panel', { itemId, panelId });
      expect(await inTheInbox(itemId)).toBe(true);
    });

    it('keeps a finished Item’s card', async () => {
      const { itemId } = await aFiledItem('Storm scene');
      const cardId = await aCard(itemId);
      await ok('set_done', { itemId, done: true });
      const read = await snapshot();
      expect(read.whiteboards.cards.map((card) => card.id)).toEqual([cardId]);
      expect(read.items.find((item) => item.id === itemId)?.completedAt).not.toBeNull();
    });

    it('takes a dismissed Item’s cards off every board, and Undo of the dismiss brings them back', async () => {
      const { itemId } = await aFiledItem('Storm scene');
      const plot = await aDashboard('Plot');
      await aCard(itemId);
      await aCard(itemId, plot);
      const before = (await snapshot()).whiteboards.cards;

      await ok('set_dismissed', { itemId, dismissed: true });
      expect((await snapshot()).whiteboards.cards).toEqual([]);

      await ok('set_dismissed', { itemId, dismissed: false });
      expect((await snapshot()).whiteboards.cards).toEqual(before);
    });

    it('brings back the cards of an Item dismissed twice, from two tabs, with one Undo', async () => {
      const { itemId } = await aFiledItem('Storm scene');
      await aCard(itemId);
      const before = (await snapshot()).whiteboards.cards;
      await ok('set_dismissed', { itemId, dismissed: true });
      await ok('set_dismissed', { itemId, dismissed: true });
      await ok('set_dismissed', { itemId, dismissed: false });
      expect((await snapshot()).whiteboards.cards).toEqual(before);
    });

    it('puts back no card whose Item is in the Inbox by then', async () => {
      const { itemId, panelId } = await aFiledItem('Storm scene');
      const cardId = await aCard(itemId);
      await ok('take_card_off', { cardId });
      await ok('remove_item_from_panel', { itemId, panelId });
      expect((await ok('put_cards_back', { cardIds: [cardId] })).applied).toBe(false);
      expect(await cardsOf(itemId)).toEqual([]);
    });
  });
});

describe('Whiteboard', () => {
  describe('dragging a card on the board moves it between boxes and open space and files nothing', () => {
    it.each([
      { situation: 'into a box', into: 'box' as const, boxIs: 'that box' },
      { situation: 'onto open space', into: 'space' as const, boxIs: 'none' },
      { situation: 'into a box inside a box', into: 'inner' as const, boxIs: 'the inner box' },
    ])('puts a card dropped $situation in $boxIs, and leaves every filing as it was', async ({ into }) => {
      const { itemId } = await aFiledItem('Storm scene');
      const outer = await aBox('Act one');
      const inner = await aBox('People', outer);
      const cardId = await aCard(itemId, DASHBOARD_ID, outer);
      const filedBefore = (await snapshot()).filings;

      const boxId = into === 'box' ? outer : into === 'inner' ? inner : null;
      await ok('move_card', { cardId, boxId, x: 30, y: 60 });

      expect(await cardsOf(itemId)).toEqual([{ id: cardId, dashboardId: DASHBOARD_ID, itemId, boxId, x: 30, y: 60 }]);
      expect((await snapshot()).filings).toEqual(filedBefore);
    });
  });

  describe('taking a card off removes only the card', () => {
    it('leaves its filings, its parents and its children as they were', async () => {
      const { itemId: parentId } = await aFiledItem('Chapter 3');
      const { itemId, panelId } = await aFiledItem('Storm scene');
      const childId = await anItem('Waves');
      await ok('add_children', { parentId, childIds: [itemId] });
      await ok('add_children', { parentId: itemId, childIds: [childId] });
      const cardId = await aCard(itemId);
      const before = await snapshot();

      await ok('take_card_off', { cardId });

      const after = await snapshot();
      expect(after.whiteboards.cards).toEqual([]);
      expect(after.filings).toEqual(before.filings);
      expect(after.children).toEqual(before.children);
      expect(after.filings.some((filing) => filing.panelId === panelId && filing.itemId === itemId)).toBe(true);
      expect(after.items.map((item) => item.id).sort()).toEqual(before.items.map((item) => item.id).sort());
    });
  });

  describe('putting an Item inside a card makes it a parent holding the Item, and never a Panel or a box', () => {
    it('adds the Item to the one on the card, creating no Panel and no box', async () => {
      const target = await aFiledItem('Chapter 3');
      const { itemId } = await aFiledItem('Storm scene');
      await aCard(target.itemId);
      const [panels, boxes] = [(await snapshot()).panels.length, (await snapshot()).whiteboards.boxes.length];

      await ok('add_children', { parentId: target.itemId, childIds: [itemId] });

      const read = await snapshot();
      expect(read.children?.filter((row) => row.parentId === target.itemId).map((row) => row.childId)).toEqual([itemId]);
      expect(read.items.some((item) => item.id === target.itemId)).toBe(true);
      expect([read.panels.length, read.whiteboards.boxes.length]).toEqual([panels, boxes]);
    });
  });

  describe('Combine on the board draws the new parent at the first card’s spot, in its box', () => {
    async function combine(childIds: string[], panelId: string | null, cardId = nextId()) {
      const parentId = nextId();
      await ok('combine_under_new_parent', {
        parentId,
        title: 'Combined: crossing',
        description: null,
        childIds,
        panelId,
        dashboardId: null,
        onBoard: { dashboardId: DASHBOARD_ID, cardId },
      });
      return { parentId, cardId };
    }

    it('puts the parent’s card in the first card’s box, at its spot, and takes the cards of what it holds off', async () => {
      const first = await aFiledItem('Storm scene');
      const second = await aFiledItem('Ferry scene');
      const boxId = await aBox('Act one');
      await aCard(first.itemId, DASHBOARD_ID, boxId);
      await aCard(second.itemId);

      const { parentId, cardId } = await combine([first.itemId, second.itemId], first.panelId);

      expect((await snapshot()).whiteboards.cards).toEqual([{ id: cardId, dashboardId: DASHBOARD_ID, itemId: parentId, boxId, x: 10, y: 20 }]);
    });

    it('puts it on open space where the first card is on open space', async () => {
      const first = await aFiledItem('Storm scene');
      const second = await aFiledItem('Ferry scene');
      await ok('move_card', { cardId: await aCard(first.itemId), boxId: null, x: 300, y: 80 });

      const { parentId, cardId } = await combine([first.itemId, second.itemId], first.panelId);

      expect((await snapshot()).whiteboards.cards).toEqual([{ id: cardId, dashboardId: DASHBOARD_ID, itemId: parentId, boxId: null, x: 300, y: 80 }]);
    });

    it('makes the parent a child of the Item the first one is inside, and draws it too', async () => {
      const holder = await aFiledItem('Chapter 3');
      const first = await anItem('Storm scene');
      const second = await anItem('Ferry scene');
      await ok('add_children', { parentId: holder.itemId, childIds: [first, second] });
      await aCard(first);

      const { parentId, cardId } = await combine([first, second], null);

      const read = await snapshot();
      expect(read.children?.some((row) => row.parentId === holder.itemId && row.childId === parentId)).toBe(true);
      expect(read.whiteboards.cards).toEqual([expect.objectContaining({ id: cardId, itemId: parentId })]);
    });

    it('places nothing where the first Item has no card on this board, and leaves the cards it has', async () => {
      const first = await aFiledItem('Storm scene');
      const second = await aFiledItem('Ferry scene');
      const secondCard = await aCard(second.itemId);

      await combine([first.itemId, second.itemId], first.panelId);

      expect((await snapshot()).whiteboards.cards.map((card) => card.id)).toEqual([secondCard]);
    });

    it('places no card for a parent that lands in the Inbox, and leaves the cards of what it holds', async () => {
      const first = await aFiledItem('Storm scene');
      const second = await aFiledItem('Ferry scene');
      const firstCard = await aCard(first.itemId);

      const { parentId } = await combine([first.itemId, second.itemId], null);

      expect(await inTheInbox(parentId)).toBe(true);
      expect((await snapshot()).whiteboards.cards.map((card) => card.id)).toEqual([firstCard]);
    });
  });
});

describe('Whiteboard', () => {
  describe('one Workspace never names another’s boards', () => {
    it('refuses a card placed on a Dashboard of another Workspace', async () => {
      const { itemId } = await aFiledItem('Storm scene');
      const res = await asUser(`${ORIGIN}/v1/commands/place_card`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ commandId: nextId(), issuedAt: later(), workspaceId: 'ws-2', cardId: nextId(), dashboardId: DASHBOARD_ID, itemId, boxId: null, x: 0, y: 0 }),
      });
      expect(res.status).toBe(404);
      expect(await cardsOn()).toEqual([]);
    });
  });

  describe('the same change sent twice is applied once', () => {
    it('places one card for a card placed twice, though its box has gone since', async () => {
      const { itemId } = await aFiledItem('Storm scene');
      const boxId = await aBox('People');
      const placing = { cardId: nextId(), dashboardId: DASHBOARD_ID, itemId, boxId, x: 0, y: 0 };
      await ok('place_card', placing);
      await ok('delete_box', { boxId });
      expect((await ok('place_card', placing)).applied).toBe(false);
      expect(await rowsIn('board_cards')).toBe(1);
    });


    it('draws one box for a box drawn twice', async () => {
      const boxId = await aBox('People');
      expect((await ok('draw_box', { boxId, dashboardId: DASHBOARD_ID, parentBoxId: null, label: 'People', colour: null, x: 0, y: 0, w: 1, h: 1 })).applied).toBe(false);
      expect(await rowsIn('board_boxes')).toBe(1);
    });
  });
});
