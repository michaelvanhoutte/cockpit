import { describe, expect, it } from 'vitest';
import type { CommandPayload, RecurringItem, RecurringItemList } from '@cockpit/shared';
import type { Drawn } from '../../src/drawnAhead';
import { recurringItemsDrawnOver } from '../../src/recurringItemsDrawnAhead';

/**
 * F1: what each change to a recurring item draws over the list the server sent.
 * That the modal sends them and draws the result is
 * tests/unit/components/RecurringItemsModal.test.tsx; when they stop being drawn
 * is tests/unit/changeQueue.test.ts.
 */

const AT = '2082-10-22T10:00:00.000Z';
const WEEKLY: RecurringItem = {
  id: '018f0000-0000-7000-8000-000000000001',
  workspaceId: 'ws-work',
  title: 'Weekly review',
  description: '',
  priority: null,
  panelIds: [],
  frequency: 'weekly',
  nextOn: '2082-11-02',
  dueAfterDays: 5,
};
const VAT: RecurringItem = { ...WEEKLY, id: '018f0000-0000-7000-8000-000000000002', title: 'Quarterly VAT', frequency: 'quarterly', nextOn: '2082-12-01' };
const held: RecurringItemList = { recurringItems: [WEEKLY, VAT] };
const over = recurringItemsDrawnOver('ws-work');

const content = (item: RecurringItem) => ({
  title: item.title,
  description: item.description,
  priority: item.priority,
  panelIds: item.panelIds,
  repeat: { frequency: item.frequency, nextOn: item.nextOn, dueAfterDays: item.dueAfterDays, timeZone: 'Europe/Brussels' },
});
const envelope = (workspaceId = 'ws-work') => ({ commandId: 'c-1', issuedAt: AT, workspaceId });

const made = (item: RecurringItem, workspaceId = 'ws-work'): Drawn => ({
  name: 'create_recurring_item',
  payload: { ...envelope(workspaceId), seriesId: item.id, ...content(item) } as CommandPayload<'create_recurring_item'>,
});
const written = (item: RecurringItem, workspaceId = 'ws-work'): Drawn => ({
  name: 'write_recurring_item',
  payload: { ...envelope(workspaceId), seriesId: item.id, ...content(item) } as CommandPayload<'write_recurring_item'>,
});
const deleted = (id: string, workspaceId = 'ws-work'): Drawn => ({
  name: 'delete_recurring_item',
  payload: { ...envelope(workspaceId), seriesId: id },
});

const NEW: RecurringItem = { ...WEEKLY, id: '018f0000-0000-7000-8000-000000000003', title: 'Monthly invoices', frequency: 'monthly' };

describe('Workspace management', () => {
  describe('a change to a recurring item is drawn as the server will hold it', () => {
    it.each([
      { situation: 'made: a row at the end', change: made(NEW), titles: ['Weekly review', 'Quarterly VAT', 'Monthly invoices'] },
      { situation: 'made, and a read already holds it: not a second row', change: made(VAT), titles: ['Weekly review', 'Quarterly VAT'] },
      { situation: 'written: the row, whole', change: written({ ...WEEKLY, title: 'Review' }), titles: ['Review', 'Quarterly VAT'] },
      { situation: 'deleted: the row is gone', change: deleted(WEEKLY.id), titles: ['Quarterly VAT'] },
      { situation: 'written, and the row is not in the copy: nothing to write over', change: written(NEW), titles: ['Weekly review', 'Quarterly VAT'] },
      { situation: 'made in another Workspace: not drawn here', change: made(NEW, 'ws-home'), titles: ['Weekly review', 'Quarterly VAT'] },
      { situation: 'deleted in another Workspace: not drawn here', change: deleted(WEEKLY.id, 'ws-home'), titles: ['Weekly review', 'Quarterly VAT'] },
    ])('$situation', ({ change, titles }) => {
      expect(over(held, [change]).recurringItems.map((one) => one.title)).toEqual(titles);
    });

    it('draws a written row with the rule, Panels and priority it was sent with', () => {
      const panelId = '018f0000-0000-7000-8000-0000000000aa';
      const rewritten: RecurringItem = { ...WEEKLY, priority: 'high', panelIds: [panelId], frequency: 'daily', nextOn: '2082-11-05', dueAfterDays: null };

      expect(over(held, [written(rewritten)]).recurringItems[0]).toEqual(rewritten);
    });

    it('draws each change over the one before it, in the order they were made', () => {
      const drawn = over(held, [made(NEW), written({ ...NEW, title: 'Invoices' }), deleted(WEEKLY.id)]);

      expect(drawn.recurringItems.map((one) => one.title)).toEqual(['Quarterly VAT', 'Invoices']);
    });

    it('never writes into the list it was handed', () => {
      over(held, [made(NEW), deleted(WEEKLY.id)]);

      expect(held.recurringItems.map((one) => one.title)).toEqual(['Weekly review', 'Quarterly VAT']);
    });

    it('leaves a change that is not a recurring item\'s alone', () => {
      const other: Drawn = { name: 'disconnect_app', payload: { appId: 'app-1' } };

      expect(over(held, [other])).toBe(held);
    });
  });
});
