import { describe, expect, it } from 'vitest';
import type { Item } from '@cockpit/shared';
import { FIND_PAGE, cursorFor, pageOfMatches, readCursor, type ItemSearch } from '../../../src/domain/item-search.js';

/**
 * L1: which Items a connected app's search answers with and which page of them:
 * text, status, priority and due worked out over rows already read, the order,
 * and the cursor that continues a page. That the rows come from the account's
 * own store, and that each carries where it is filed, is
 * tests/integration/http/find-items.test.ts.
 */

function anItem(id: string, over: Partial<Item> = {}): Item {
  return {
    id,
    title: id,
    description: null,
    nextAction: null,
    sender: null,
    startedAt: null,
    completedAt: null,
    priority: null,
    dueDate: null,
    updatedAt: '2026-10-19T08:00:00.000Z',
    ...over,
  } as Item;
}

const EVERYTHING: ItemSearch = {
  workspaceId: null,
  panel: null,
  includeDone: false,
  text: null,
  status: null,
  priority: null,
  due: null,
  today: '2026-10-19',
  after: null,
};
const searching = (over: Partial<ItemSearch>): ItemSearch => ({ ...EVERYTHING, ...over });
const idsOf = (items: Item[], search: ItemSearch) => pageOfMatches(items, search).items.map((item) => item.id);

describe('MCP connections', () => {
  describe('an app finds the items matching the text, the way Find item matches it', () => {
    const items = [
      anItem('in-the-title', { title: 'Renew the PASSPORT' }),
      anItem('in-the-description', { description: 'bring the passport photos' }),
      anItem('in-the-next-action', { nextAction: 'Book a passport appointment' }),
      anItem('in-the-sender', { sender: 'Passport Office' }),
      anItem('elsewhere', { title: 'Water the plants' }),
    ];

    it.each([
      { situation: 'words in the title, in another case', text: 'passport', found: ['in-the-title', 'in-the-description', 'in-the-next-action', 'in-the-sender'] },
      { situation: 'words only the sender holds', text: 'office', found: ['in-the-sender'] },
      { situation: 'words around which there are spaces', text: '  photos  ', found: ['in-the-description'] },
      { situation: 'words no item holds', text: 'dentist', found: [] },
      { situation: 'nothing typed at all', text: '   ', found: items.map((item) => item.id) },
    ])('$situation', ({ text, found }) => {
      expect(idsOf(items, searching({ text })).toSorted()).toEqual(found.toSorted());
    });
  });

  describe('an app finds the items meeting every condition it gave', () => {
    const items = [
      anItem('high-today', { priority: 'high', dueDate: '2026-10-19', startedAt: '2026-10-18T08:00:00.000Z' }),
      anItem('high-last-month', { priority: 'high', dueDate: '2026-09-02' }),
      anItem('normal-this-week', { priority: 'normal', dueDate: '2026-10-21' }),
      anItem('no-priority-no-date'),
    ];

    it.each([
      { situation: 'a priority', over: { priority: 'high' as const }, found: ['high-today', 'high-last-month'] },
      { situation: 'no priority', over: { priority: 'none' as const }, found: ['no-priority-no-date'] },
      { situation: 'In progress', over: { status: 'in_progress' as const }, found: ['high-today'] },
      { situation: 'To do', over: { status: 'to_do' as const }, found: ['high-last-month', 'normal-this-week', 'no-priority-no-date'] },
      { situation: 'due today, counting what is overdue', over: { due: { window: 'today' as const, orOverdue: true } }, found: ['high-today', 'high-last-month'] },
      { situation: 'due today alone', over: { due: { window: 'today' as const, orOverdue: false } }, found: ['high-today'] },
      { situation: 'overdue', over: { due: { window: 'overdue' as const, orOverdue: false } }, found: ['high-last-month'] },
      { situation: 'due this week, counted from the day given', over: { due: { window: 'week' as const, orOverdue: false } }, found: ['high-today', 'normal-this-week'] },
      { situation: 'due this week, counted from another day', over: { due: { window: 'week' as const, orOverdue: false }, today: '2026-10-26' }, found: [] },
      { situation: 'no due date', over: { due: { window: 'none' as const, orOverdue: false } }, found: ['no-priority-no-date'] },
      { situation: 'a priority and a due window together', over: { priority: 'high' as const, due: { window: 'today' as const, orOverdue: false } }, found: ['high-today'] },
    ])('$situation', ({ over, found }) => {
      expect(idsOf(items, searching(over)).toSorted()).toEqual(found.toSorted());
    });

    it('meets text and conditions together', () => {
      const both = [anItem('a', { title: 'Tax return', priority: 'high' }), anItem('b', { title: 'Tax return' }), anItem('c', { title: 'Garden', priority: 'high' })];

      expect(idsOf(both, searching({ text: 'tax', priority: 'high' }))).toEqual(['a']);
    });
  });

  describe('an app is given the most recently changed items first, a page at a time', () => {
    const changed = (n: number) => `2026-10-19T08:00:${String(n).padStart(2, '0')}.000Z`;
    const many = Array.from({ length: 26 }, (_, n) => anItem(`item-${String(n).padStart(2, '0')}`, { updatedAt: changed(n) }));

    it('gives a page of 25, newest change first, and a cursor where the 26th follows', () => {
      const first = pageOfMatches(many, EVERYTHING);

      expect(FIND_PAGE).toBe(25);
      expect(first.items.map((item) => item.id)).toEqual(many.slice(1).reverse().map((item) => item.id));
      expect(first.next).not.toBeNull();
    });

    it('continues with the 26th and then ends without a cursor', () => {
      const first = pageOfMatches(many, EVERYTHING);

      const second = pageOfMatches(many, searching({ after: readCursor(first.next!) }));

      expect(second.items.map((item) => item.id)).toEqual(['item-00']);
      expect(second.next).toBeNull();
    });

    it('gives no cursor where exactly a page matches', () => {
      expect(pageOfMatches(many.slice(0, 25), EVERYTHING).next).toBeNull();
    });

    it('returns each of several items changed at one moment once across the edge of a page', () => {
      const sameMoment = Array.from({ length: 30 }, (_, n) => anItem(`same-${String(n).padStart(2, '0')}`, { updatedAt: changed(7) }));

      const first = pageOfMatches(sameMoment, EVERYTHING);
      const second = pageOfMatches(sameMoment, searching({ after: readCursor(first.next!) }));

      const all = [...first.items, ...second.items].map((item) => item.id);
      expect(all).toHaveLength(30);
      expect(new Set(all).size).toBe(30);
    });

    it('does not repeat an item the cursor has passed when the rows come in another order', () => {
      const first = pageOfMatches(many, EVERYTHING);

      const second = pageOfMatches(many.toReversed(), searching({ after: readCursor(first.next!) }));

      expect(second.items.map((item) => item.id)).toEqual(['item-00']);
    });
  });

  describe('a cursor is given back as Cockpit gave it, and refused in words as anything else', () => {
    it('reads back the change time and id it was made from', () => {
      const cursor = cursorFor({ updatedAt: '2026-10-19T08:00:07.123Z', id: '0192f1c5-aaaa-7bbb-8ccc-0123456789ab' });

      expect(readCursor(cursor)).toEqual({ changedAt: '2026-10-19T08:00:07.123Z', id: '0192f1c5-aaaa-7bbb-8ccc-0123456789ab' });
      expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it.each([
      { situation: 'words', cursor: 'next page please' },
      { situation: 'text that is not encoded', cursor: '!!!!' },
      { situation: 'something encoded that is no position', cursor: btoa('hello') },
      { situation: 'a position with no id', cursor: btoa('2026-10-19T08:00:07.123Z\n') },
      { situation: 'a time that is no time', cursor: btoa('yesterday\nabc') },
      { situation: 'far too much', cursor: 'a'.repeat(500) },
    ])('reads $situation as no cursor', ({ cursor }) => {
      expect(readCursor(cursor)).toBeNull();
    });
  });
});
