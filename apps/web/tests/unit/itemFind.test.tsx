import { describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { Item, WorkspaceSnapshot } from '@cockpit/shared';
import { FIND_LIMIT, findItems, indexForFind, useFindIndex } from '../../src/itemFind';

/**
 * F1: Find item matches in the browser over a snapshot the read model already
 * holds, so it is a view over a fixed snapshot. What the column draws from it
 * is tests/unit/components/PanelList.test.tsx.
 */
function anItem(id: string, over: Partial<Item> = {}): Item {
  return {
    id,
    title: id,
    description: null,
    nextAction: null,
    sender: null,
    completedAt: null,
    updatedAt: '2026-08-31T08:00:00.000Z',
    ...over,
  } as Item;
}

/** Dashboards `today` and `later`; Panels `inbox-ish` and `plan` on Today, `review` on Later; a Filter panel `gather`. */
function aSnapshot(items: Item[], filed: [string, string][] = []): WorkspaceSnapshot {
  return {
    items,
    dashboards: [
      { id: 'today', name: 'Today' },
      { id: 'later', name: 'Later' },
    ],
    panels: [
      { id: 'plan', dashboardId: 'today', name: 'Plan', kind: 'items' },
      { id: 'urgent', dashboardId: 'today', name: 'Urgent', kind: 'items' },
      { id: 'review', dashboardId: 'later', name: 'Review', kind: 'items' },
      { id: 'gather', dashboardId: 'today', name: 'Gathered', kind: 'filter', filter: { due: null } },
    ],
    filings: filed.map(([itemId, panelId], position) => ({ itemId, panelId, position })),
  } as unknown as WorkspaceSnapshot;
}

const rowsFor = (snapshot: WorkspaceSnapshot, query: string, scope: 1 | 2 = 2) =>
  findItems(indexForFind(snapshot), query, scope, 'today');

describe('Dashboards', () => {
  describe('Find lists the open Items in scope that match what is typed, in any of four fields', () => {
    it('lists nothing until something is typed', () => {
      expect(rowsFor(aSnapshot([anItem('a')]), '  ')).toEqual({ rows: [], more: 0 });
    });

    it.each([
      { situation: 'the title', over: { title: 'Pay conselit.be' } },
      { situation: 'the description', over: { description: 'invoice from conselit.be' } },
      { situation: 'the next action', over: { nextAction: 'Call conselit.be' } },
      { situation: 'the sender', over: { sender: 'billing@conselit.be' } },
    ])('matches in $situation only', ({ over }) => {
      const snapshot = aSnapshot([anItem('a', over), anItem('b')]);
      expect(rowsFor(snapshot, 'CONSELIT.BE').rows.map((row) => row.itemId)).toEqual(['a']);
    });

    it('keeps this Dashboard’s Items in Dashboard, every open one in Workspace, and no finished one', () => {
      const snapshot = aSnapshot(
        [anItem('here-o'), anItem('away-o'), anItem('inbox-o'), anItem('done-o', { completedAt: '2026-08-31T09:00:00.000Z' })],
        [['here-o', 'plan'], ['away-o', 'review'], ['done-o', 'plan']],
      );
      expect(rowsFor(snapshot, 'o', 1).rows.map((row) => row.itemId)).toEqual(['here-o']);
      expect(rowsFor(snapshot, 'o', 2).rows.map((row) => row.itemId).toSorted()).toEqual(['away-o', 'here-o', 'inbox-o']);
    });

    it('treats an Item filed on a Filter panel only as the Inbox’s', () => {
      const snapshot = aSnapshot([anItem('a')], [['a', 'gather']]);
      expect(rowsFor(snapshot, 'a', 2).rows[0]?.where).toBe('Inbox');
      expect(rowsFor(snapshot, 'a', 1).rows).toEqual([]);
    });
  });

  describe('a row says what the Item is and where, most recently changed first', () => {
    it('names the Panel in Dashboard, and Dashboard ▸ Panel with +n in Workspace, once for an Item on two Panels', () => {
      const snapshot = aSnapshot([anItem('a'), anItem('b')], [['a', 'plan'], ['a', 'review']]);
      expect(rowsFor(snapshot, 'a', 1).rows[0]?.where).toBe('Plan');
      expect(rowsFor(snapshot, 'a', 2).rows).toHaveLength(1);
      expect(rowsFor(snapshot, 'a', 2).rows[0]?.where).toBe('Today ▸ Plan +1');
      expect(rowsFor(snapshot, 'b', 2).rows[0]?.where).toBe('Inbox');
    });

    it('puts the Dashboard on screen’s Panel first for an Item on another Dashboard too', () => {
      const snapshot = aSnapshot([anItem('a')], [['a', 'review'], ['a', 'urgent']]);
      expect(rowsFor(snapshot, 'a', 2).rows[0]?.panel?.panelId).toBe('urgent');
    });

    it('lists the one changed last first', () => {
      const snapshot = aSnapshot([
        anItem('old', { title: 'rent old', updatedAt: '2026-08-01T00:00:00.000Z' }),
        anItem('new', { title: 'rent new', updatedAt: '2026-08-30T00:00:00.000Z' }),
      ]);
      expect(rowsFor(snapshot, 'rent').rows.map((row) => row.itemId)).toEqual(['new', 'old']);
    });
  });

  describe('at most 50 rows are drawn', () => {
    const many = (n: number) => aSnapshot(Array.from({ length: n }, (_, at) => anItem(`item-${at}`)));

    it('draws 50 matches with no tail, and 51 with one more counted', () => {
      expect(rowsFor(many(FIND_LIMIT), 'item')).toMatchObject({ more: 0 });
      expect(rowsFor(many(FIND_LIMIT), 'item').rows).toHaveLength(50);
      expect(rowsFor(many(FIND_LIMIT + 1), 'item')).toMatchObject({ more: 1 });
      expect(rowsFor(many(FIND_LIMIT + 1), 'item').rows).toHaveLength(50);
    });
  });

  describe('each Item’s search text is built once per snapshot, not per keystroke', () => {
    it('derives it once for five letters, and again for a replaced snapshot where an edit now matches', () => {
      let reads = 0;
      const counted = anItem('a');
      Object.defineProperty(counted, 'description', {
        get: () => {
          reads += 1;
          return 'Pay the rent';
        },
      });
      const first = aSnapshot([counted]);
      const { result, rerender } = renderHook(({ snapshot }) => useFindIndex(snapshot), {
        initialProps: { snapshot: first },
      });
      for (const typed of ['r', 're', 'ren', 'rent', 'rent ']) findItems(result.current, typed, 2, 'today');
      rerender({ snapshot: first });
      expect(reads).toBe(1);

      const edited = aSnapshot([anItem('a', { title: 'Pay the VAT' })]);
      rerender({ snapshot: edited });
      expect(findItems(result.current, 'vat', 2, 'today').rows).toHaveLength(1);
      expect(findItems(result.current, 'rent', 2, 'today').rows).toHaveLength(0);
    });
  });
});
