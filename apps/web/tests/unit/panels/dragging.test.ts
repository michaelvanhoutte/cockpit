import { describe, expect, it } from 'vitest';
import { arrangedWith, placementFor } from '../../../src/panels/dragging';
import type { DrawnRow } from '../../../src/panels/dragging';
import type { LayoutRow } from '@cockpit/shared';

/**
 * L1: where a panel would land is arithmetic over rectangles and a point, so
 * every rule about it is provable without a browser. That the rectangles are
 * where the page actually put them is the browser's half, and is the one walk
 * in tests/e2e/panels.test.ts.
 *
 * The rows below are laid out the way the board draws them: bands 100 tall, a
 * 22-pixel seam between each while a drag is on, and the panels across a row
 * splitting 0-600 evenly.
 */
function drawn(rows: string[][]): DrawnRow[] {
  return rows.map((panelIds, index) => {
    const top = index * 122;
    const width = 600 / panelIds.length;
    return {
      top,
      bottom: top + 100,
      cells: panelIds.map((panelId, at) => ({
        panelId,
        left: at * width,
        right: (at + 1) * width,
      })),
    };
  });
}

/** The same arrangement as the rows the layout stores. */
function stored(rows: string[][]): LayoutRow[] {
  return rows.map((panelIds) => ({
    height: null,
    cells: panelIds.map((panelId) => ({ panelId, span: 12 / panelIds.length })),
  }));
}

/** The arrangement as the panels on each line, which is what these cases are about. */
const lines = (rows: readonly LayoutRow[]) => rows.map((row) => row.cells.map((c) => c.panelId));

describe('Panels', () => {
  describe('a panel being dragged goes where the pointer is, on the row or between two', () => {
    const rows = drawn([['a', 'b'], ['c']]);

    // A slot between two panels is named from the right of it: past a's middle
    // is `before b` rather than `after a`, which is the same place said the
    // other way round. Only the slot past the last panel has nothing to its
    // right, and that is the one `after` names.
    it.each([
      { situation: 'before the first panel', x: 10, y: 50, is: { on: 'beside', panelId: 'a', side: 'before' } },
      { situation: 'past the first panel’s middle', x: 290, y: 50, is: { on: 'beside', panelId: 'b', side: 'before' } },
      { situation: 'past the last panel’s middle', x: 590, y: 50, is: { on: 'beside', panelId: 'b', side: 'after' } },
      { situation: 'the gap between two rows', x: 300, y: 110, is: { on: 'ownRow', at: 1 } },
      { situation: 'above the first row', x: 300, y: -10, is: { on: 'ownRow', at: 0 } },
      { situation: 'below the last row', x: 300, y: 400, is: { on: 'ownRow', at: 2 } },
    ])('$situation', ({ x, y, is }) => {
      // `c` is the panel being dragged in every one of these: it is on a row
      // of its own, so none of these positions is over it.
      expect(placementFor({ x, y }, rows, 'c')).toEqual(is);
    });

    it('asks for nothing on a dashboard with no rows to be over', () => {
      // A dashboard with no panels draws no rows, and a drag cannot start on
      // one - but the board asks this on every pointer move and must get an
      // answer rather than an exception.
      expect(placementFor({ x: 0, y: 0 }, [], 'a')).toBeNull();
    });

    it.each([
      { situation: 'its left half', x: 310 },
      { situation: 'its right half', x: 590 },
    ])('asks for nothing where the pointer is over the dragged panel, on $situation', ({ x }) => {
      // Where the pointer spends most of a drag, because the rows handed in
      // are the rows as drawn and what is drawn already has the panel moved.
      // Answered as no change here: left to `movedBeside`, beside-itself is
      // refused by handing back the arrangement at pick-up, which throws the
      // preview away and puts the panel back where it started.
      //
      // `b`, which is last on its row: a slot is named from the panel to its
      // right, so only the panel with nothing to its right ever names itself
      // from both halves. Past the middle of a panel that has a neighbour is
      // the slot before that neighbour, which is a real place to go.
      expect(placementFor({ x, y: 50 }, rows, 'b')).toBeNull();
    });
  });

  describe('the arrangement a placement would produce is what the board draws', () => {
    it('puts the panel beside the one the pointer is on', () => {
      const rows = stored([['a', 'b'], ['c']]);

      const next = arrangedWith(rows, 'c', { on: 'beside', panelId: 'a', side: 'before' });

      expect(lines(next)).toEqual([['c', 'a', 'b']]);
    });

    it('puts the panel on a line of its own at the gap', () => {
      const rows = stored([['a', 'b']]);

      const next = arrangedWith(rows, 'b', { on: 'ownRow', at: 0 });

      expect(lines(next)).toEqual([['b'], ['a']]);
    });

    it('leaves the arrangement alone where the move cannot happen', () => {
      // A row already `MOST_ACROSS` across takes no more, and the preview has
      // to say so by showing nothing happening - a preview that promised a
      // move the drop then declined would be the gesture lying about itself.
      const rows = stored([['a', 'b', 'c', 'd'], ['e']]);

      const next = arrangedWith(rows, 'e', { on: 'beside', panelId: 'a', side: 'after' });

      expect(lines(next)).toEqual([['a', 'b', 'c', 'd'], ['e']]);
    });

    it('leaves the arrangement alone when it is asked for the line it is already alone on', () => {
      // The two gaps either side of a row holding one panel are that panel's
      // own line. They used to light up under the pointer and then do nothing,
      // which is what made the bars unreadable.
      const rows = stored([['a'], ['b']]);

      expect(lines(arrangedWith(rows, 'b', { on: 'ownRow', at: 1 }))).toEqual([['a'], ['b']]);
      expect(lines(arrangedWith(rows, 'b', { on: 'ownRow', at: 2 }))).toEqual([['a'], ['b']]);
    });
  });
});
