import { describe, expect, it } from 'vitest';
import type { Item } from '@cockpit/shared';
import {
  afterClicking,
  afterEnding,
  afterPickingAll,
  afterPruning,
  afterUpdating,
  dashboardScope,
  inboxScope,
  NOTHING_HELD,
  NOTHING_PICKED,
  pickedInTheList,
  selectionIn,
  shownIn,
  type Held,
  type Selection,
} from '../../src/selection';

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

  describe('a Dashboard holds one selection across all its Panels, counting each Item once', () => {
    const TODAY = dashboardScope('today');
    const FALCON = ['a', 'b', 'c'];
    const READING = ['x', 'y', 'b'];
    const clickIn = (held: Held, ids: string[], id: string, withShift = false) =>
      afterUpdating(held, TODAY, (was) => afterClicking(ids, was, id, withShift));

    it('adds a pick on a second Panel to what the first holds', () => {
      const held = clickIn(clickIn(NOTHING_HELD, FALCON, 'a'), READING, 'x');

      expect([...selectionIn(held, TODAY).picked]).toEqual(['a', 'x']);
    });

    it('ticks an Item shown on two Panels on both, and counts it once', () => {
      const held = clickIn(NOTHING_HELD, FALCON, 'b');
      const picked = selectionIn(held, TODAY);

      expect(pickedInTheList(picked, FALCON.map(anItem)).map((item) => item.id)).toEqual(['b']);
      expect(pickedInTheList(picked, READING.map(anItem)).map((item) => item.id)).toEqual(['b']);
      expect(picked.picked.size).toBe(1);
    });

    it('picks the one row when a shift-click is on another Panel than the last pick', () => {
      const held = clickIn(clickIn(NOTHING_HELD, FALCON, 'a'), READING, 'y', true);

      // A span never crosses Panels: `a` is not in the second one to reach back to.
      expect([...selectionIn(held, TODAY).picked]).toEqual(['a', 'y']);
    });

    it('holds nothing once the last Item is put back, and the next pick starts afresh', () => {
      const held = clickIn(clickIn(NOTHING_HELD, FALCON, 'a'), FALCON, 'a');

      expect(held).toBe(NOTHING_HELD);
      expect(selectionIn(clickIn(held, FALCON, 'c', true), TODAY).reachingFrom).toBe('c');
    });
  });

  describe('one scope holds a selection at a time, and leaving it ends it', () => {
    const TODAY = dashboardScope('today');
    const HOME = inboxScope('ws-home');
    const picking = (scope: string, id: string) =>
      afterUpdating(NOTHING_HELD, scope, (was) => afterClicking(ROWS, was, id, false));

    it.each([
      { situation: 'the Inbox ends a Dashboard’s selection', first: TODAY, then: HOME },
      { situation: 'a Panel ends the Inbox’s selection', first: HOME, then: TODAY },
    ])('picking in $situation', ({ first, then }) => {
      const held = afterUpdating(picking(first, 'a'), then, (was) => afterClicking(ROWS, was, 'b', false));

      expect(selectionIn(held, first).picked.size).toBe(0);
      expect([...selectionIn(held, then).picked]).toEqual(['b']);
    });

    it('finds nothing picked in another Dashboard, or another Workspace’s Inbox', () => {
      const held = picking(TODAY, 'a');

      expect(selectionIn(held, dashboardScope('later')).picked.size).toBe(0);
      expect(selectionIn(held, inboxScope('ws-other')).picked.size).toBe(0);
    });

    it('ends when its own scope does, and only then', () => {
      const held = picking(TODAY, 'a');

      expect(afterEnding(held, TODAY)).toBe(NOTHING_HELD);
      expect(afterEnding(held, HOME)).toBe(held);
      expect(afterEnding(held)).toBe(NOTHING_HELD);
    });
  });

  describe('a picked Item no shown Panel holds leaves the selection; nothing else empties it', () => {
    const TODAY = dashboardScope('today');
    const HOME = inboxScope('ws-home');
    const holding = (...ids: string[]): Held => ({ scope: TODAY, selection: picking(...ids) });

    it('drops what none of the lists shows, and keeps what any of them does', () => {
      const shown = shownIn(
        [
          { scope: TODAY, ids: ['a'] },
          { scope: TODAY, ids: ['b', 'c'] },
        ],
        TODAY,
      );

      const held = afterPruning(holding('a', 'b', 'z'), TODAY, shown);

      expect([...selectionIn(held, TODAY).picked]).toEqual(['a', 'b']);
    });

    it('keeps an Item moved from one Panel to another of the same Dashboard', () => {
      const held = afterPruning(
        holding('a'),
        TODAY,
        shownIn([{ scope: TODAY, ids: ['b'] }, { scope: TODAY, ids: ['a'] }], TODAY),
      );

      expect([...selectionIn(held, TODAY).picked]).toEqual(['a']);
    });

    it('lets go of the row a shift-click would have reached back to when it leaves', () => {
      const held = afterPruning(holding('a', 'b'), TODAY, new Set(['a']));

      expect(selectionIn(held, TODAY).reachingFrom).toBeNull();
    });

    it('holds nothing once every picked Item has left', () => {
      expect(afterPruning(holding('a'), TODAY, new Set(['q']))).toBe(NOTHING_HELD);
    });

    it('is not emptied by another scope’s housekeeping', () => {
      // The Inbox's refresh drops the rows it no longer shows, from a selection
      // it does not hold - which must not take the Dashboard's over with nothing.
      const held = holding('a', 'b');

      expect(afterPruning(held, HOME, new Set())).toBe(held);
      expect(afterUpdating(held, HOME, () => NOTHING_PICKED)).toBe(held);
      // Even a fresh, empty one: nothing picked is not a selection to take over with.
      expect(afterUpdating(held, HOME, () => ({ picked: new Set(), reachingFrom: null }))).toBe(held);
      expect(afterEnding(held, HOME)).toBe(held);
    });

    it('counts only the lists of the scope asked about', () => {
      const shown = shownIn([{ scope: TODAY, ids: ['a'] }, { scope: HOME, ids: ['z'] }], TODAY);

      expect([...shown]).toEqual(['a']);
    });
  });

  describe('Select all adds what a Panel shows, or what the Dashboard shows, to what is picked', () => {
    const TODAY = dashboardScope('today');

    it('adds a Panel’s rows to what is already picked on another', () => {
      const held = afterPickingAll({ scope: TODAY, selection: picking('x') }, TODAY, ['a', 'b']);

      expect([...selectionIn(held, TODAY).picked]).toEqual(['x', 'a', 'b']);
    });

    it('picks every row of every Panel, an Item on two Panels counted once', () => {
      const shown = shownIn([{ scope: TODAY, ids: ['a', 'b'] }, { scope: TODAY, ids: ['b', 'c'] }], TODAY);

      const held = afterPickingAll(NOTHING_HELD, TODAY, shown);

      expect([...selectionIn(held, TODAY).picked]).toEqual(['a', 'b', 'c']);
    });

    it('ends the other scope’s selection when it starts one', () => {
      const held = afterPickingAll({ scope: inboxScope('ws-home'), selection: picking('z') }, TODAY, ['a']);

      expect(selectionIn(held, inboxScope('ws-home')).picked.size).toBe(0);
      expect([...selectionIn(held, TODAY).picked]).toEqual(['a']);
    });

    it('starts nothing from nothing', () => {
      expect(afterPickingAll(NOTHING_HELD, TODAY, [])).toBe(NOTHING_HELD);
    });
  });
});
