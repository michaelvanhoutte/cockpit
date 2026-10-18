import { describe, expect, it } from 'vitest';
import type { Filing, Item, Panel } from '@cockpit/shared';
import { FIND_PAGE, itemsOnPanelsNamed, meetsFind, pageOfFound, panelsNamed, type FindQuery } from '../../../src/domain/find-items.js';

/**
 * L1: which Items meet what `find_items` asked, and where a page ends. That the
 * rows are the account's own, and reach the app, is
 * tests/integration/http/connected-apps.test.ts's; how text is matched per field
 * is the shared Find rule's own (packages/shared/tests/unit/domain/item-find.test.ts).
 */

const TODAY = '2026-10-14';

function anItem(over: Partial<Item> = {}): Item {
  return {
    id: '0198f6a0-0000-7000-8000-000000000001',
    tenantId: 'tenant-default',
    workspaceId: 'ws-1',
    workspaceDecided: true,
    capturedMessage: null,
    capturedTimeZone: null,
    source: 'internal',
    sourceId: null,
    sourceLink: null,
    sender: null,
    sourceTimestamp: null,
    sourceResolvedAt: null,
    title: 'Call the plumber',
    description: null,
    textsSettledAt: null,
    textsProposedAt: null,
    readings: null,
    proposedPanelId: null,
    proposedPanelReason: null,
    proposedPanelFit: null,
    claudeProposals: null,
    nextAction: null,
    completedAt: null,
    startedAt: null,
    priority: null,
    prioritySetAt: null,
    dueDate: null,
    dueDateSetAt: null,
    dueDateChosenAt: null,
    unseen: false,
    deletedAt: null,
    createdAt: '2026-10-01T09:00:00.000Z',
    updatedAt: '2026-10-01T09:00:00.000Z',
    ...over,
  };
}

const asked = (over: Partial<FindQuery> = {}): FindQuery => ({
  workspaceId: null,
  panel: null,
  text: '',
  status: null,
  priority: null,
  due: null,
  includeDone: false,
  today: TODAY,
  after: null,
  ...over,
});

describe('MCP connections', () => {
  describe('an app finds the items that meet every condition it gives', () => {
    it.each([
      { situation: 'no condition at all', query: {}, item: {}, meets: true },
      { situation: 'text in the title, in any case', query: { text: 'PLUMBER' }, item: {}, meets: true },
      { situation: 'text in the sender alone', query: { text: 'gmail' }, item: { sender: 'Gmail' }, meets: true },
      { situation: 'text in no field', query: { text: 'boiler' }, item: {}, meets: false },
      { situation: 'the status asked for', query: { status: 'in_progress' }, item: { startedAt: '2026-10-02T09:00:00.000Z' }, meets: true },
      { situation: 'another status', query: { status: 'in_progress' }, item: {}, meets: false },
      { situation: 'the priority asked for', query: { priority: 'high' }, item: { priority: 'high' }, meets: true },
      { situation: 'another priority', query: { priority: 'high' }, item: { priority: 'low' }, meets: false },
      { situation: 'no priority, asked for as none', query: { priority: 'none' }, item: {}, meets: true },
      { situation: 'a due date inside the week asked for', query: { due: 'week' }, item: { dueDate: '2026-10-16' }, meets: true },
      { situation: 'a due date past the week asked for', query: { due: 'week' }, item: { dueDate: '2026-10-19' }, meets: false },
      { situation: 'a due date already past, in a period asked for', query: { due: 'week' }, item: { dueDate: '2026-09-30' }, meets: true },
      { situation: 'no due date, in a period asked for', query: { due: 'week' }, item: {}, meets: false },
      { situation: 'no due date, asked for as not set', query: { due: 'none' }, item: {}, meets: true },
      {
        situation: 'text, priority and due together, all met',
        query: { text: 'plumber', priority: 'high', due: 'today' },
        item: { priority: 'high', dueDate: TODAY },
        meets: true,
      },
      {
        situation: 'text, priority and due together, one missed',
        query: { text: 'plumber', priority: 'high', due: 'today' },
        item: { priority: 'normal', dueDate: TODAY },
        meets: false,
      },
    ] as const)('$situation', ({ query, item, meets }) => {
      expect(meetsFind(anItem(item), asked(query))).toBe(meets);
    });

    it('counts a due window from the day the app gave, not from the day it is', () => {
      const dueTheFifteenth = anItem({ dueDate: '2026-10-15' });

      expect(meetsFind(dueTheFifteenth, asked({ due: 'today', today: '2026-10-15' }))).toBe(true);
      expect(meetsFind(dueTheFifteenth, asked({ due: 'today', today: '2026-10-14' }))).toBe(false);
    });
  });

  describe('an app is shown a page of 25 items, most recently changed first, and a cursor for the next', () => {
    const at = (minute: number) => `2026-10-10T10:${String(minute).padStart(2, '0')}:00.000Z`;
    const idOf = (n: number) => `0198f6a0-0000-7000-8000-${String(n).padStart(12, '0')}`;
    const many = (count: number) =>
      Array.from({ length: count }, (_, n) => anItem({ id: idOf(n + 1), updatedAt: at(n) }));

    it('gives the newest 25 and a cursor at the 25th when more follow', () => {
      const { page, next } = pageOfFound(many(26), null);

      expect(page).toHaveLength(FIND_PAGE);
      expect(page[0]?.id).toBe(idOf(26));
      expect(next).toEqual({ updatedAt: page.at(-1)?.updatedAt, id: page.at(-1)?.id });
    });

    it('gives the rest and no cursor when the cursor is read, repeating and skipping nothing', () => {
      const first = pageOfFound(many(26), null);
      const second = pageOfFound(many(26), first.next);

      expect(second.page.map((item) => item.id)).toEqual([idOf(1)]);
      expect(second.next).toBeNull();
      expect(new Set([...first.page, ...second.page].map((item) => item.id)).size).toBe(26);
    });

    it('gives no cursor for a page that is the last', () => {
      expect(pageOfFound(many(25), null).next).toBeNull();
    });

    it('returns an item changed at the same moment as the last of the page once, on one side of the edge', () => {
      const tied = Array.from({ length: 27 }, (_, n) => anItem({ id: idOf(n + 1), updatedAt: at(5) }));

      const first = pageOfFound(tied, null);
      const second = pageOfFound(tied, first.next);

      const ids = [...first.page, ...second.page].map((item) => item.id);
      expect([ids.length, new Set(ids).size]).toEqual([27, 27]);
    });
  });
});

function aPanel(id: string, name: string, over: Partial<Panel> = {}): Panel {
  return {
    id,
    tenantId: 'tenant-default',
    dashboardId: 'dash-1',
    name,
    kind: 'items',
    format: 'plain',
    body: '',
    readOnly: false,
    neverPropose: false,
    filter: null,
    sort: null,
    columns: null,
    ...over,
  };
}

const onPanel = (panelId: string, itemId: string, position = 0): Filing => ({ panelId, itemId, position });

/** What a Workspace holds, ready for `itemsOnPanelsNamed`. */
const holding = (items: Item[], filings: Filing[], panels: Panel[]) => ({
  items,
  filings,
  panelsInWorkspace: panels,
  dashboards: [{ id: 'dash-1' }, { id: 'dash-2' }],
  withRun: new Set<string>(),
  today: TODAY,
});
const idsOf = (items: Item[]) => items.map((item) => item.id).toSorted();

describe('MCP connections', () => {
  describe('an app finds the items on a panel by its name', () => {
    const a = anItem({ id: 'a', priority: 'high' });
    const b = anItem({ id: 'b', priority: 'low' });
    const c = anItem({ id: 'c', priority: 'high' });

    it('gives the items filed on a panel of that name, in any case, and none that are filed elsewhere', () => {
      const panels = [aPanel('p1', 'Boiler'), aPanel('p2', 'Other')];
      const filings = [onPanel('p1', 'a'), onPanel('p1', 'b'), onPanel('p2', 'c')];

      expect(idsOf(itemsOnPanelsNamed('boiler ', holding([a, b, c], filings, panels)))).toEqual(['a', 'b']);
    });

    it('gives the items of both where two panels on different dashboards go by the name, an item on both once', () => {
      const panels = [aPanel('p1', 'Boiler'), aPanel('p2', 'BOILER', { dashboardId: 'dash-2' })];
      const filings = [onPanel('p1', 'a'), onPanel('p2', 'a'), onPanel('p2', 'c')];

      expect(idsOf(itemsOnPanelsNamed('Boiler', holding([a, b, c], filings, panels)))).toEqual(['a', 'c']);
    });

    it('gives what a filter panel of the name gathers from what is filed elsewhere, as the board does', () => {
      const gathers = aPanel('f1', 'Urgent', {
        kind: 'filter',
        filter: { rows: [[{ field: 'priority', values: ['high'] }]], groupBy: 'none' },
      });
      const panels = [aPanel('p1', 'Boiler'), gathers];
      const filings = [onPanel('p1', 'a'), onPanel('p1', 'b')];

      expect(idsOf(itemsOnPanelsNamed('urgent', holding([a, b, c], filings, panels)))).toEqual(['a']);
    });

    it('gives nothing for a panel of text, which holds no items', () => {
      const text = aPanel('t1', 'Notes', { kind: 'text' });

      expect(itemsOnPanelsNamed('Notes', holding([a], [], [text]))).toEqual([]);
    });

    it('finds the panels by name without regard to case, and none where no panel has it', () => {
      const panels = [aPanel('p1', 'Straße'), aPanel('p2', 'Other')];

      expect(panelsNamed(panels, 'STRASSE').map((panel) => panel.id)).toEqual(['p1']);
      expect(panelsNamed(panels, 'Nothing')).toEqual([]);
    });
  });
});
