import { describe, expect, it } from 'vitest';
import type { Dashboard, Filing, Item, Panel } from '@cockpit/shared';
import { finishedItems, groupOf, markedDoneRows } from '../../src/markedDone';

/**
 * F1, and pure: what the window of items marked done lists, and how a row
 * reads, are decisions over one snapshot and a clock handed in ("See the items
 * you have marked done, from the header menu", issue 637). That the window
 * draws them is tests/unit/components/MarkedDoneWindow.test.tsx.
 */

// Local noon, so a day boundary is a deliberate offset from it rather than an accident of the zone.
const NOW = new Date(2026, 8, 16, 12, 0, 0);

function at(daysBefore: number, hour: number, minute = 0): string {
  return new Date(2026, 8, 16 - daysBefore, hour, minute, 0).toISOString();
}

let next = 0;
function anItem(fields: Partial<Item> = {}): Item {
  next += 1;
  return {
    id: `item-${next}`,
    title: `Item ${next}`,
    description: null,
    nextAction: null,
    sender: null,
    typeId: null,
    completedAt: at(0, 10),
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
  { id: 'p-soon', dashboardId: 'd-work', name: 'Due soon', kind: 'filter' },
] as Panel[];

function rowsOf(items: Item[], filings: Filing[] = [], search = '') {
  return markedDoneRows(
    {
      items,
      filings,
      panels: PANELS,
      dashboards: DASHBOARDS,
      itemTypes: [{ id: 't-task', name: 'Task' }],
    },
    search,
    NOW,
  );
}

const filed = (itemId: string, panelId: string): Filing => ({ itemId, panelId, position: 0 });

describe('Triage', () => {
  describe('the window lists the finished items, newest finished first', () => {
    it.each([
      { situation: 'finished here', item: { completedAt: at(0, 9) }, listed: true },
      {
        situation: 'finished, belonging to no workspace yet',
        item: { completedAt: at(0, 9), workspaceDecided: false },
        listed: true,
      },
      { situation: 'not finished', item: { completedAt: null }, listed: false },
    ])('$situation', ({ item, listed }) => {
      expect(rowsOf([anItem(item)])).toHaveLength(listed ? 1 : 0);
    });

    it('lists the most recently finished first', () => {
      const early = anItem({ title: 'early', completedAt: at(0, 8) });
      const late = anItem({ title: 'late', completedAt: at(0, 11) });
      const older = anItem({ title: 'older', completedAt: at(3, 20) });

      expect(finishedItems([early, older, late]).map((item) => item.title)).toEqual([
        'late',
        'early',
        'older',
      ]);
    });
  });

  describe('a row says when it was finished and where it was filed', () => {
    const done = anItem({ completedAt: at(0, 10) });

    it.each([
      {
        situation: 'on one Panel',
        filings: [filed(done.id, 'p-admin')],
        line: 'Done 2h ago · was on Day to day ▸ Admin & money',
      },
      {
        situation: 'on several Panels, naming each',
        filings: [filed(done.id, 'p-calls'), filed(done.id, 'p-admin')],
        line: 'Done 2h ago · was on Day to day ▸ Admin & money, Work ▸ Calls',
      },
      {
        situation: 'on a Filter panel only, which is no filing',
        filings: [filed(done.id, 'p-soon')],
        line: 'Done 2h ago · was in the Inbox',
      },
      { situation: 'filed nowhere', filings: [], line: 'Done 2h ago · was in the Inbox' },
      {
        situation: 'on a Panel since deleted',
        filings: [filed(done.id, 'p-gone')],
        line: 'Done 2h ago · was in the Inbox',
      },
    ])('$situation', ({ filings, line }) => {
      expect(rowsOf([done], filings)[0]!.line).toBe(line);
    });

    it('says just now for a finish under a minute old', () => {
      const justNow = anItem({ completedAt: new Date(NOW.getTime() - 20_000).toISOString() });

      expect(rowsOf([justNow])[0]!.line).toBe('Done just now · was in the Inbox');
    });

    it('carries the Type, or none', () => {
      expect(rowsOf([anItem({ typeId: 't-task' })])[0]!.type).toBe('Task');
      expect(rowsOf([anItem({ typeId: 't-deleted' })])[0]!.type).toBeNull();
    });
  });

  describe('search narrows by title, description or next action, and not by sender', () => {
    it.each([
      { situation: 'in the title', fields: { title: 'Pay the invoice' }, found: true },
      { situation: 'in the description', fields: { description: 'the INVOICE is late' }, found: true },
      { situation: 'in the next action', fields: { nextAction: 'Send invoice' }, found: true },
      { situation: 'with the case differing', fields: { title: 'INVOICE' }, found: true },
      { situation: 'in the sender only', fields: { sender: 'invoice@acme.test' }, found: false },
      { situation: 'nowhere', fields: { title: 'Buy milk' }, found: false },
    ])('$situation', ({ fields, found }) => {
      expect(rowsOf([anItem(fields)], [], ' invoice ')).toHaveLength(found ? 1 : 0);
    });
  });

  describe('items are grouped by the day they were finished, in the viewer’s day', () => {
    it.each([
      { situation: 'just after midnight today', completedAt: at(0, 0, 1), group: 'Today' },
      { situation: '23:59 yesterday', completedAt: at(1, 23, 59), group: 'Previous 7 days' },
      { situation: '7 days ago', completedAt: at(7, 6), group: 'Previous 7 days' },
      { situation: '8 days ago', completedAt: at(8, 23, 59), group: 'Earlier' },
    ])('$situation', ({ completedAt, group }) => {
      expect(groupOf(completedAt, NOW)).toBe(group);
    });
  });
});
