import { describe, expect, it } from 'vitest';
import { placesFiledOn, whereItIs, type Dashboard, type Filing, type Item, type Panel } from '../../../src/index.js';

/**
 * L1: where an item is, as *All items* says it in its *Where it is* column -
 * moved here with every case kept, now that the Worker names a place the same
 * way for a connected app's ind_items (issue 1240). That the table draws it
 * is apps/web/tests/unit/components/AllItemsBoard.test.tsx.
 */

const DASHBOARDS = [
  { id: 'd-day', name: 'Day to day' },
  { id: 'd-work', name: 'Work' },
] as Dashboard[];
const PANELS = [
  { id: 'p-admin', dashboardId: 'd-day', name: 'Admin & money', kind: 'items' },
  { id: 'p-calls', dashboardId: 'd-work', name: 'Calls', kind: 'items' },
] as Panel[];
const filed = (itemId: string, panelId: string): Filing => ({ itemId, panelId, position: 0 });
const anItem = (fields: Partial<Item>): Item => ({ completedAt: null, ...fields }) as Item;

describe('Inbox', () => {
  describe('each row says where the item is', () => {
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
      expect(whereItIs(placesFiledOn(anItem({ id: 'x', ...item }), filings, PANELS, DASHBOARDS))).toBe(where);
    });
  });
});

