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
      { situation: 'the gap between two rows', x: 300, y: 110, is: { on: 'ownRow', under: 'b' } },
      { situation: 'above the first row', x: 300, y: -10, is: { on: 'ownRow', under: null } },
    ])('$situation', ({ x, y, is }) => {
      // `c` is the panel being dragged in every one of these: it is on a row
      // of its own, so none of these positions is over it.
      expect(placementFor({ x, y }, rows, 'c')).toEqual(is);
    });

    it('names the gap under the last row by the panel on that row', () => {
      // Dragging `a`, so the row below is somebody else's and the gap under it
      // is a real place to go - unlike the same gap for `c`, which is already
      // alone there.
      expect(placementFor({ x: 300, y: 400 }, rows, 'a')).toEqual({ on: 'ownRow', under: 'c' });
    });

    it('names the gap under a row the panel shares by the panel it is sharing with', () => {
      // Two things at once, and both were got wrong in turn. The gap under a row
      // a panel is *sharing* is a line of its own - the one move that takes a
      // panel off a shared row, and the whole point of dragging it downwards -
      // where the gap under a row it has to itself is where it already is. And
      // the panel that names it has to be one the drag has not moved: `b` is
      // drawn here and somewhere else in the arrangement this will be applied
      // to, so naming the gap after it points at a different gap there.
      expect(placementFor({ x: 300, y: 110 }, rows, 'b')).toEqual({ on: 'ownRow', under: 'a' });
    });

    it('names it by the panel beside it even where the dragged one is drawn last', () => {
      // The shape a drag actually reaches: a panel dropped onto the end of
      // another row, then pushed down into the seam below it. The row above the
      // gap is then `[a, c]` with `c` the one in hand, so the last panel up
      // there is the one panel that cannot name anything.
      const drawnMidDrag = drawn([['a', 'c'], ['b']]);

      expect(placementFor({ x: 300, y: 110 }, drawnMidDrag, 'c')).toEqual({
        on: 'ownRow',
        under: 'a',
      });
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

  describe('a pointer held still settles the arrangement rather than flipping it', () => {
    /**
     * The rule the whole gesture rests on, and the one four separate bugs broke
     * in turn.
     *
     * A placement is measured against the rows *as drawn* - which already show
     * the preview - and applied to the arrangement the drag started from. The
     * board therefore feeds itself: what it draws changes what the next reading
     * says. Held still, that has to come to rest. Where it did not, the preview
     * flipped between two arrangements for as long as the pointer twitched, and
     * a release landing on the wrong frame sent nothing at all while the panel
     * had visibly moved.
     *
     * **Settling, not standing still on the first reading.** Moving a panel
     * moves the rows under the pointer, so one further step is honest: the
     * pointer really is over something else now. What is not allowed is a cycle
     * - two arrangements trading places for ever - and that is what this walks
     * every slot and every seam of a board looking for.
     *
     * Each of those four bugs was found in review, one case at a time, each fix
     * narrower than the last. This asks the rule instead.
     */
    const boards = [
      [['a'], ['b'], ['c']],
      [['a', 'b'], ['c']],
      [['a'], ['b', 'c']],
      [['a', 'b', 'c']],
    ];

    /** Every place on the board a pointer can be: along each row, and in each seam. */
    function everywhere(rows: DrawnRow[]): { x: number; y: number }[] {
      const spots: { x: number; y: number }[] = [{ x: 300, y: rows[0]!.top - 11 }];
      for (const row of rows) {
        const middle = (row.top + row.bottom) / 2;
        for (const cell of row.cells) {
          spots.push({ x: cell.left + 5, y: middle });
          spots.push({ x: (cell.left + cell.right) / 2 + 5, y: middle });
          spots.push({ x: cell.right - 5, y: middle });
        }
        spots.push({ x: 300, y: row.bottom + 11 });
      }
      return spots;
    }

    it.each(boards.flatMap((board) => board.flat().map((dragged) => ({ board, dragged }))))(
      'settles anywhere on $board while $dragged is in hand',
      ({ board, dragged }) => {
        const from = stored(board);

        for (const spot of everywhere(drawn(board))) {
          let preview = from;
          const seen: string[] = [];
          // Four readings is generous: a move takes one, and the step the moved
          // rows buy takes another. A board still changing on the fourth is one
          // that is never going to stop.
          for (let reading = 0; reading < 4; reading += 1) {
            seen.push(JSON.stringify(lines(preview)));
            const placement = placementFor(spot, drawn(lines(preview)), dragged);
            if (!placement) break;
            preview = arrangedWith(from, dragged, placement);
          }

          const settled = JSON.stringify(lines(preview));
          expect(
            seen[seen.length - 1],
            `at (${spot.x}, ${spot.y}) with ${dragged} in hand, the board never came to rest: ` +
              seen.join(' then '),
          ).toEqual(settled);
        }
      },
    );
  });

  describe('the arrangement a placement would produce is what the board draws', () => {
    it('puts the panel beside the one the pointer is on', () => {
      const rows = stored([['a', 'b'], ['c']]);

      const next = arrangedWith(rows, 'c', { on: 'beside', panelId: 'a', side: 'before' });

      expect(lines(next)).toEqual([['c', 'a', 'b']]);
    });

    it('puts the panel on a line of its own at the top', () => {
      const rows = stored([['a', 'b']]);

      const next = arrangedWith(rows, 'b', { on: 'ownRow', under: null });

      expect(lines(next)).toEqual([['b'], ['a']]);
    });

    it('puts the panel on a line of its own under the row the gap names', () => {
      // The gap is named by the panel above it, so the same placement means
      // the same gap in the arrangement it is measured against and the one it
      // is applied to - which are two different arrangements while a drag is
      // on. Numbered, it meant a different gap in each the moment the drag
      // had moved the panel off the row it started on.
      const rows = stored([['a'], ['b'], ['c']]);

      const next = arrangedWith(rows, 'a', { on: 'ownRow', under: 'b' });

      expect(lines(next)).toEqual([['b'], ['a'], ['c']]);
    });

    it('leaves the arrangement alone when the panel naming the gap has gone', () => {
      // Deleted in another tab while the drag was on. Guessing at a line is
      // worse than leaving the panels where they are.
      const rows = stored([['a'], ['b']]);

      expect(lines(arrangedWith(rows, 'a', { on: 'ownRow', under: 'gone' }))).toEqual([
        ['a'],
        ['b'],
      ]);
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
      // The gap either side of a row holding one panel is that panel's own
      // line. They used to light up under the pointer and then do nothing,
      // which is what made the bars unreadable.
      const rows = stored([['a'], ['b']]);

      expect(lines(arrangedWith(rows, 'b', { on: 'ownRow', under: 'a' }))).toEqual([
        ['a'],
        ['b'],
      ]);
    });

    it('asks for nothing where the gap is the one under the panel being dragged', () => {
      // The gap under a row the panel is already alone on is where it already
      // is - and naming it after itself is the same meaningless placement a
      // slot over itself would be.
      const rows = drawn([['a'], ['b']]);

      expect(placementFor({ x: 300, y: 110 }, rows, 'a')).toBeNull();
    });
  });
});
