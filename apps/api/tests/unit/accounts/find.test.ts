import { describe, expect, it } from 'vitest';
import { NO_DASHBOARD_FILTER, type DashboardFilter, type Item } from '@cockpit/shared';
import {
  FIND_PAGE,
  encodeCursor,
  isAfterCursor,
  itemMeets,
  newestFirst,
  pageOf,
  readCursor,
  type FindQuery,
} from '../../../src/accounts/find.js';

/**
 * L1: which Items a connected app's search meets and how they are cut into
 * pages ("Find items in Cockpit from a connected app, over MCP", issue 1240).
 * The rules for text, status, priority and due are the screen's own, held by
 * packages/shared/tests/unit; that the rows reach these rules from the
 * account's store is tests/integration/http/connected-apps.test.ts.
 */

let next = 0;
function anItem(fields: Partial<Item> = {}): Item {
  next += 1;
  return {
    id: `item-${String(next).padStart(3, '0')}`,
    title: `Item ${next}`,
    description: null,
    nextAction: null,
    sender: null,
    priority: null,
    dueDate: null,
    startedAt: null,
    completedAt: null,
    updatedAt: '2026-10-10T10:00:00.000Z',
    ...fields,
  } as Item;
}

const TODAY = '2026-10-14';

function queryOf(fields: Partial<Omit<FindQuery, 'filter'>> & { filter?: Partial<DashboardFilter> } = {}): FindQuery {
  const { filter, ...rest } = fields;
  return {
    workspaceId: null,
    panelIds: null,
    text: '',
    filter: { ...NO_DASHBOARD_FILTER, ...filter },
    includeDone: false,
    today: TODAY,
    after: null,
    ...rest,
  };
}

describe('MCP connections', () => {
  describe('an item meets a search when it meets every criterion given', () => {
    it.each([
      { situation: 'text in the title', item: { title: 'Pay the Invoice' }, text: 'invoice', meets: true },
      { situation: 'text in the description', item: { description: 'about the VAT return' }, text: 'vat', meets: true },
      { situation: 'text in the next action', item: { nextAction: 'Ask for the number' }, text: 'ASK', meets: true },
      { situation: 'text in the sender only', item: { sender: 'alex@example.com' }, text: 'alex@', meets: true },
      { situation: 'text in none of them', item: { title: 'Rent' }, text: 'invoice', meets: false },
      { situation: 'no text at all', item: { title: 'Rent' }, text: '', meets: true },
    ])('$situation', ({ item, text, meets }) => {
      expect(itemMeets(queryOf({ text }), anItem(item), null)).toBe(meets);
    });

    it.each([
      { situation: 'priority High, a High item', filter: { priorities: ['high' as const] }, item: { priority: 'high' as const }, meets: true },
      { situation: 'priority High, a Low item', filter: { priorities: ['high' as const] }, item: { priority: 'low' as const }, meets: false },
      { situation: 'priority none, an item with none', filter: { priorities: ['none' as const] }, item: {}, meets: true },
      { situation: 'status In progress, one started', filter: { statuses: ['in_progress' as const] }, item: { startedAt: '2026-10-01T09:00:00.000Z' }, meets: true },
      { situation: 'status In progress, one not started', filter: { statuses: ['in_progress' as const] }, item: {}, meets: false },
    ])('$situation', ({ filter, item, meets }) => {
      expect(itemMeets(queryOf({ filter }), anItem(item), null)).toBe(meets);
    });

    it.each([
      { situation: 'due this week, counted from the given today', today: '2026-10-14', dueDate: '2026-10-18', meets: true },
      { situation: 'the same item, counted from a today in the week after', today: '2026-10-21', dueDate: '2026-10-18', meets: false },
      { situation: 'the same item, counted from a today in the week after, where overdue counts', today: '2026-10-21', dueDate: '2026-10-18', meets: true, orOverdue: true },
    ])('$situation', ({ today, dueDate, meets, orOverdue = false }) => {
      const query = queryOf({ today, filter: { due: { window: 'week', orOverdue } } });
      expect(itemMeets(query, anItem({ dueDate }), null)).toBe(meets);
    });

    it('needs the item to meet text, priority and the rest all together', () => {
      const query = queryOf({ text: 'quote', filter: { priorities: ['high'] } });
      expect(itemMeets(query, anItem({ title: 'Send the quote', priority: 'high' }), null)).toBe(true);
      expect(itemMeets(query, anItem({ title: 'Send the quote', priority: 'low' }), null)).toBe(false);
      expect(itemMeets(query, anItem({ title: 'Send the bill', priority: 'high' }), null)).toBe(false);
    });

    it.each([
      { situation: 'a named panel holding it', gathered: 'held', meets: true },
      { situation: 'a named panel not holding it', gathered: 'not held', meets: false },
    ])('$situation', ({ gathered, meets }) => {
      const item = anItem();
      const holding = new Set(gathered === 'held' ? [item.id] : ['another']);
      expect(itemMeets(queryOf({ panelIds: ['p'] }), item, holding)).toBe(meets);
    });
  });

  describe('open items only, unless the finished are asked for', () => {
    const finished = anItem({ completedAt: '2026-10-09T09:00:00.000Z' });

    it.each([
      { situation: 'a finished item, without include_done', includeDone: false, meets: false },
      { situation: 'a finished item, with include_done', includeDone: true, meets: true },
    ])('$situation', ({ includeDone, meets }) => {
      expect(itemMeets(queryOf({ includeDone }), finished, null)).toBe(meets);
    });
  });

  describe('pages of 25, newest change first, continued by a cursor that repeats and skips nothing', () => {
    const rows = (count: number) =>
      Array.from({ length: count }, (_, at) =>
        anItem({ updatedAt: `2026-10-${String(28 - at).padStart(2, '0')}T08:00:00.000Z` }),
      ).sort(newestFirst);

    it('gives 25 and then more follow, with the cursor that gives the 26th and no more', () => {
      const all = rows(26);
      const first = pageOf(all, queryOf(), null);
      expect(first.page).toHaveLength(FIND_PAGE);
      expect(first.next).toEqual({ updatedAt: all[24]!.updatedAt, id: all[24]!.id });

      const second = pageOf(all, queryOf({ after: first.next }), null);
      expect(second.page.map((item) => item.id)).toEqual([all[25]!.id]);
      expect(second.next).toBeNull();
    });

    it('gives no cursor for exactly a page', () => {
      expect(pageOf(rows(25), queryOf(), null).next).toBeNull();
    });

    it('counts only the items meeting the search toward a page, and puts the most recently changed first', () => {
      const all = [
        anItem({ title: 'old match', updatedAt: '2026-10-01T08:00:00.000Z' }),
        anItem({ title: 'no', updatedAt: '2026-10-05T08:00:00.000Z' }),
        anItem({ title: 'new match', updatedAt: '2026-10-09T08:00:00.000Z' }),
      ].sort(newestFirst);
      expect(pageOf(all, queryOf({ text: 'match' }), null).page.map((item) => item.title)).toEqual(['new match', 'old match']);
    });

    it('returns each of two items changed at the same moment once, though the page edge falls between them', () => {
      const same = '2026-10-12T08:00:00.000Z';
      const tied = Array.from({ length: FIND_PAGE + 2 }, (_, at) =>
        anItem({ id: `tie-${String(at).padStart(2, '0')}`, updatedAt: same }),
      ).sort(newestFirst);
      const first = pageOf(tied, queryOf(), null);
      const second = pageOf(tied, queryOf({ after: first.next }), null);
      expect([...first.page, ...second.page].map((item) => item.id)).toEqual(tied.map((item) => item.id));
      expect(second.next).toBeNull();
    });

    it('orders by the id where two changed together, and puts an item after a cursor only when it comes later in that order', () => {
      const cursor = { updatedAt: '2026-10-12T08:00:00.000Z', id: 'b' };
      expect(isAfterCursor({ updatedAt: '2026-10-12T08:00:00.000Z', id: 'a' }, cursor)).toBe(true);
      expect(isAfterCursor({ updatedAt: '2026-10-12T08:00:00.000Z', id: 'b' }, cursor)).toBe(false);
      expect(isAfterCursor({ updatedAt: '2026-10-12T08:00:00.000Z', id: 'c' }, cursor)).toBe(false);
      expect(isAfterCursor({ updatedAt: '2026-10-11T08:00:00.000Z', id: 'z' }, cursor)).toBe(true);
      expect(isAfterCursor({ updatedAt: '2026-10-13T08:00:00.000Z', id: 'a' }, cursor)).toBe(false);
    });

    it('reads back the cursor it gave, and nothing else', () => {
      const cursor = { updatedAt: '2026-10-12T08:00:00.000Z', id: 'item-7' };
      expect(readCursor(encodeCursor(cursor))).toEqual(cursor);
      for (const raw of [undefined, 7, '', 'not a cursor!', btoa('x'), btoa('[1,2]'), btoa('["not a time","x"]'), btoa('["2026-10-12T08:00:00.000Z",""]'), 'a'.repeat(401)]) {
        expect(readCursor(raw)).toBeNull();
      }
    });
  });
});
