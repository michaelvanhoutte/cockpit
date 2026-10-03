import { describe, expect, it } from 'vitest';
import type { Dashboard, Filing, Item, Panel } from '@cockpit/shared';
import { DEFAULT_SORT, allItemsRows, pressHeader, type AllItemsKey } from '../../src/allItems';

/**
 * F1, and pure: what the All items table lists, how a row reads and how a
 * header orders it are decisions over one snapshot ("Put each setting where a
 * person looks for it", issue 688). That the page draws them and a row opens
 * the form is tests/unit/components/AllItemsBoard.test.tsx.
 */

let next = 0;
function anItem(fields: Partial<Item> = {}): Item {
  next += 1;
  return {
    id: `item-${next}`,
    title: `Item ${next}`,
    typeId: null,
    priority: null,
    dueDate: null,
    startedAt: null,
    completedAt: null,
    updatedAt: '2026-09-10T10:00:00.000Z',
    ...fields,
  } as Item;
}

const DASHBOARDS = [
  { id: 'd-day', name: 'Day to day' },
  { id: 'd-work', name: 'Work' },
] as Dashboard[];
const PANELS = [
  { id: 'p-admin', dashboardId: 'd-day', name: 'Admin & money', kind: 'items' },
  { id: 'p-calls', dashboardId: 'd-work', name: 'Calls', kind: 'items' },
] as Panel[];
const filed = (itemId: string, panelId: string): Filing => ({ itemId, panelId, position: 0 });

function rowsOf(items: Item[], filings: Filing[] = [], sort = DEFAULT_SORT) {
  return allItemsRows(
    {
      items,
      filings,
      panels: PANELS,
      dashboards: DASHBOARDS,
      itemTypes: [{ id: 't-task', name: 'Task' }],
    },
    sort,
  );
}

describe('Inbox', () => {
  describe('All items shows every item of the workspace, finished ones included', () => {
    it.each([
      { situation: 'an item filed on a panel', item: {}, filings: [filed('x', 'p-calls')] },
      { situation: 'an item never filed', item: {}, filings: [] },
      { situation: 'a finished item', item: { completedAt: '2026-09-11T09:00:00.000Z' }, filings: [] },
    ])('$situation is shown', ({ item, filings }) => {
      const one = anItem({ id: 'x', ...item });
      expect(rowsOf([one], filings).map((row) => row.item.id)).toEqual(['x']);
    });

    it('says Done for a finished item and To do for one not started', () => {
      const rows = rowsOf([
        anItem({ id: 'a', completedAt: '2026-09-11T09:00:00.000Z' }),
        anItem({ id: 'b' }),
        anItem({ id: 'c', startedAt: '2026-09-11T09:00:00.000Z' }),
      ]);
      expect(Object.fromEntries(rows.map((row) => [row.item.id, row.status]))).toEqual({
        a: 'done',
        b: 'to_do',
        c: 'in_progress',
      });
    });
  });

  describe('each row says what the item is, where it is and when it last changed', () => {
    it.each([
      {
        situation: 'filed on one panel',
        item: {},
        filings: [filed('x', 'p-calls')],
        where: 'Work ▸ Calls',
      },
      {
        situation: 'filed on two panels',
        item: {},
        filings: [filed('x', 'p-admin'), filed('x', 'p-calls')],
        where: 'Day to day ▸ Admin & money, Work ▸ Calls',
      },
      { situation: 'never filed', item: {}, filings: [], where: 'Inbox' },
      {
        situation: 'finished, and was filed',
        item: { completedAt: '2026-09-11T09:00:00.000Z' },
        filings: [filed('x', 'p-calls')],
        where: 'Work ▸ Calls',
      },
      {
        situation: 'finished, and never filed',
        item: { completedAt: '2026-09-11T09:00:00.000Z' },
        filings: [],
        where: 'Inbox',
      },
    ])('$situation', ({ item, filings, where }) => {
      expect(rowsOf([anItem({ id: 'x', ...item })], filings)[0]?.where).toBe(where);
    });

    it.each([
      {
        situation: 'finished',
        item: { completedAt: '2026-09-11T09:00:00.000Z', updatedAt: '2026-09-12T09:00:00.000Z' },
        changedAt: '2026-09-11T09:00:00.000Z',
      },
      {
        situation: 'not finished',
        item: { updatedAt: '2026-09-12T09:00:00.000Z' },
        changedAt: '2026-09-12T09:00:00.000Z',
      },
    ])('last changed, $situation', ({ item, changedAt }) => {
      expect(rowsOf([anItem(item)])[0]?.changedAt).toBe(changedAt);
    });

    it('leaves the priority, due date and type empty for an item with none', () => {
      const [row] = rowsOf([anItem({ typeId: 'gone' })]);
      expect([row?.priority, row?.due, row?.type]).toEqual([null, null, '']);
    });

    it('names the type, priority and due date an item has', () => {
      const [row] = rowsOf([anItem({ typeId: 't-task', priority: 'high', dueDate: '2026-09-20' })]);
      expect([row?.type, row?.priority, row?.due]).toEqual(['Task', 'high', '2026-09-20']);
    });
  });

  describe('a header sorts, newest changed first by default', () => {
    const titles = (key: AllItemsKey, items: Item[], presses = 1) => {
      let sort = DEFAULT_SORT;
      // A first press on Last changed is the default's own column, so it reverses.
      for (let i = 0; i < presses; i += 1) sort = pressHeader(sort, key);
      return rowsOf(items, [], sort).map((row) => row.title);
    };

    it('starts newest changed first', () => {
      const old = anItem({ title: 'old', updatedAt: '2026-09-01T00:00:00.000Z' });
      const fresh = anItem({ title: 'fresh', updatedAt: '2026-09-09T00:00:00.000Z' });
      const done = anItem({ title: 'done', completedAt: '2026-09-05T00:00:00.000Z' });
      expect(rowsOf([old, fresh, done]).map((row) => row.title)).toEqual(['fresh', 'done', 'old']);
    });

    it('goes ascending on the first press of another column and reversed on the next', () => {
      const [a, b] = [anItem({ title: 'Alpha' }), anItem({ title: 'beta' })];
      expect(titles('title', [b, a], 1)).toEqual(['Alpha', 'beta']);
      expect(titles('title', [b, a], 2)).toEqual(['beta', 'Alpha']);
    });

    it('puts priority high, normal, low, then none', () => {
      const items = [
        anItem({ title: 'none' }),
        anItem({ title: 'low', priority: 'low' }),
        anItem({ title: 'high', priority: 'high' }),
        anItem({ title: 'normal', priority: 'normal' }),
      ];
      expect(titles('priority', items)).toEqual(['high', 'normal', 'low', 'none']);
    });

    it('puts status To do, In progress, then Done', () => {
      const items = [
        anItem({ title: 'done', completedAt: '2026-09-11T09:00:00.000Z' }),
        anItem({ title: 'doing', startedAt: '2026-09-11T09:00:00.000Z' }),
        anItem({ title: 'todo' }),
      ];
      expect(titles('status', items)).toEqual(['todo', 'doing', 'done']);
    });

    it('puts the earliest due date first and those with none last', () => {
      const items = [
        anItem({ title: 'none' }),
        anItem({ title: 'later', dueDate: '2026-10-01' }),
        anItem({ title: 'sooner', dueDate: '2026-09-20' }),
      ];
      expect(titles('due', items)).toEqual(['sooner', 'later', 'none']);
    });
  });
});
