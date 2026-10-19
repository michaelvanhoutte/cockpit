import { describe, expect, it } from 'vitest';
import type { Dashboard, Filing, Panel } from '../../../src/index.js';
import { placesFiledOn, whereItIs } from '../../../src/index.js';

/**
 * L1: where an Item is, as *All items* says it and as the MCP `find_items`
 * tool says it. That the table draws it is apps/web/tests/unit/allItems.test.ts;
 * that `find_items` answers with it is
 * apps/api/tests/integration/http/find-items.test.ts.
 */

const DASHBOARDS = [
  { id: 'd-day', name: 'Day to day' },
  { id: 'd-work', name: 'Work' },
] as Dashboard[];
const PANELS = [
  { id: 'p-admin', dashboardId: 'd-day', name: 'Admin & money', kind: 'items' },
  { id: 'p-calls', dashboardId: 'd-work', name: 'Calls', kind: 'items' },
  { id: 'p-running', dashboardId: 'd-work', name: 'Running', kind: 'filter' },
] as Panel[];
const filed = (panelId: string): Filing => ({ itemId: 'x', panelId, position: 0 });
const whereIs = (filings: Filing[], panels = PANELS) => whereItIs(placesFiledOn({ id: 'x' }, filings, panels, DASHBOARDS));

describe('Inbox', () => {
  describe('an Item is said to be where it is filed, as Dashboard ▸ Panel for each Panel, or in the Inbox', () => {
    it.each([
      { situation: 'filed on one panel', filings: [filed('p-calls')], where: 'Work ▸ Calls' },
      {
        situation: 'filed on two panels',
        filings: [filed('p-admin'), filed('p-calls')],
        where: 'Day to day ▸ Admin & money, Work ▸ Calls',
      },
      { situation: 'never filed', filings: [], where: 'Inbox' },
      { situation: 'filed on a Filter only, which files nothing', filings: [filed('p-running')], where: 'Inbox' },
      { situation: 'filed on a panel the snapshot no longer carries', filings: [filed('p-gone')], where: 'Inbox' },
    ])('an Item $situation is $where', ({ filings, where }) => {
      expect(whereIs(filings)).toBe(where);
    });

    it('names only the filings of the Item asked about', () => {
      const others: Filing = { itemId: 'other', panelId: 'p-admin', position: 0 };
      expect(whereIs([others, filed('p-calls')])).toBe('Work ▸ Calls');
    });
  });
});
