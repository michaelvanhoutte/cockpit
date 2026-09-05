import { describe, expect, it } from 'vitest';
import type { Item } from '@cockpit/shared';
import { afterClicking, NOTHING_PICKED, pickedInTheList, type Selection } from '../../src/selection';

/**
 * F1: what a click on a tick means, decided away from any rendered list.
 *
 * The rules below are about the decision and nothing else - that the tick is
 * drawn, that clicking it reaches the decision, and that a selection is filed
 * are ItemList's, and the reveal on hover is only provable in a browser.
 */

const ROWS = ['a', 'b', 'c', 'd', 'e'];

const picking = (...ids: string[]): Selection => ({
  picked: new Set(ids),
  reachingFrom: ids.at(-1) ?? null,
});

const anItem = (id: string): Item => ({ id, title: id }) as Item;

describe('Selection', () => {
  describe('clicking a tick picks that row out, and clicking it again puts it back', () => {
    it.each([
      { situation: 'the first row picked', from: NOTHING_PICKED, id: 'b', picked: ['b'] },
      { situation: 'a second row picked', from: picking('b'), id: 'd', picked: ['b', 'd'] },
      { situation: 'a picked row put back', from: picking('b', 'd'), id: 'd', picked: ['b'] },
      {
        situation: 'the only picked row put back',
        from: picking('b'),
        id: 'b',
        picked: [],
      },
    ])('$situation', ({ from, id, picked }) => {
      expect([...afterClicking(ROWS, from, id, false).picked]).toEqual(picked);
    });
  });

  describe('shift-clicking a tick picks every row between it and the last one picked', () => {
    it.each([
      {
        situation: 'reaching down the list',
        from: picking('b'),
        id: 'd',
        picked: ['b', 'c', 'd'],
      },
      {
        situation: 'reaching back up it',
        from: picking('d'),
        id: 'b',
        picked: ['d', 'b', 'c'],
      },
      {
        situation: 'reaching to the row already picked',
        from: picking('b'),
        id: 'b',
        picked: ['b'],
      },
      {
        situation: 'keeping what was picked outside the span',
        from: { picked: new Set(['a', 'c']), reachingFrom: 'c' },
        id: 'e',
        picked: ['a', 'c', 'd', 'e'],
      },
    ])('$situation', ({ from, id, picked }) => {
      expect([...afterClicking(ROWS, from, id, true).picked]).toEqual(picked);
    });

    it.each([
      { situation: 'nothing has been picked yet', from: NOTHING_PICKED },
      { situation: 'the last row picked was put back', from: afterClicking(ROWS, picking('b'), 'b', false) },
      {
        situation: 'the row it would reach back to has left the list',
        from: { picked: new Set(['z']), reachingFrom: 'z' } as Selection,
      },
    ])('picks the one row when $situation', ({ from }) => {
      // A range with one end is a click, which is friendlier than a gesture
      // that does nothing and says nothing about why.
      expect([...afterClicking(ROWS, from, 'd', true).picked]).toContain('d');
      expect([...afterClicking(ROWS, from, 'd', true).picked]).not.toContain('c');
    });

    it('leaves a row that is already picked picked, when there is nothing to reach back to', () => {
      // The rule above holds for the row it lands on as much as for the span:
      // a shift-click adds. Reached by picking two rows and putting the second
      // back, which is what empties the anchor - and then shift-clicking the
      // first used to take it out and leave nothing picked at all.
      const anchorless = afterClicking(ROWS, picking('a', 'b'), 'b', false);

      expect([...afterClicking(ROWS, anchorless, 'a', true).picked]).toEqual(['a']);
    });
  });

  describe('a row the list no longer shows is no longer picked', () => {
    it.each([
      {
        situation: 'every picked row still shown',
        shows: ['a', 'b', 'c'],
        picked: ['a', 'c'],
        left: ['a', 'c'],
      },
      {
        situation: 'one picked row gone from the list',
        shows: ['a', 'c'],
        picked: ['a', 'b', 'c'],
        left: ['a', 'c'],
      },
      {
        situation: 'every picked row gone',
        shows: ['d'],
        picked: ['a', 'b'],
        left: [],
      },
    ])('$situation', ({ shows, picked, left }) => {
      const still = pickedInTheList({ picked: new Set(picked), reachingFrom: null }, shows.map(anItem));

      expect(still.map((item) => item.id)).toEqual(left);
    });

    it('answers in the order the list shows them, not the order they were picked', () => {
      const still = pickedInTheList(picking('d', 'a'), ROWS.map(anItem));

      expect(still.map((item) => item.id)).toEqual(['a', 'd']);
    });
  });
});
