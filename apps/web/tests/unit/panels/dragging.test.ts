import { describe, expect, it } from 'vitest';
import { arrangedWith, arrangedWithRow, placementFor, rowPlacementFor } from '../../../src/panels/dragging';
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
function drawn(rows: string[][], spans: Spans = {}): DrawnRow[] {
  return rows.map((panelIds, index) => {
    const top = index * 122;
    const total = panelIds.reduce((sum, id) => sum + (spans[id] ?? 1), 0);
    let left = 0;
    return {
      top,
      bottom: top + 100,
      cells: panelIds.map((panelId) => {
        const right = left + (600 * (spans[panelId] ?? 1)) / total;
        const cell = { panelId, left, right };
        left = right;
        return cell;
      }),
    };
  });
}

/** How much of a row a panel takes, where it is not an equal share. */
type Spans = Record<string, number>;

/** The same arrangement as the rows the layout stores. */
function stored(rows: string[][], spans: Spans = {}): LayoutRow[] {
  return rows.map((panelIds) => {
    const total = panelIds.reduce((sum, id) => sum + (spans[id] ?? 1), 0);
    return {
      height: null,
      cells: panelIds.map((panelId) => ({ panelId, span: (12 * (spans[panelId] ?? 1)) / total })),
    };
  });
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

  describe('within its own row a panel swaps once the pointer is where the swap would draw it', () => {
    /** One row of cells with the given [id, left, right], a four-pixel gap between neighbours. */
    const row = (...cells: [string, number, number][]): DrawnRow[] => [
      { top: 0, bottom: 100, cells: cells.map(([panelId, left, right]) => ({ panelId, left, right })) },
    ];
    const equal = row(['a', 0, 298], ['b', 302, 600]);
    const narrowThenWide = row(['n', 0, 100], ['w', 104, 600]);
    const wideThenNarrow = row(['w', 0, 496], ['n', 500, 600]);

    it.each([
      { situation: 'an equal neighbour to the right, the pointer just past its left edge', rows: equal, dragged: 'a', x: 303, is: { on: 'beside', panelId: 'b', side: 'after' } },
      { situation: 'an equal neighbour to the left, the pointer just inside its right edge', rows: equal, dragged: 'b', x: 297, is: { on: 'beside', panelId: 'a', side: 'before' } },
      { situation: 'a narrow panel, a wide neighbour and the pointer just inside the neighbour', rows: narrowThenWide, dragged: 'n', x: 110, is: null },
      { situation: 'the same, the pointer far enough in that the panel would land under it', rows: narrowThenWide, dragged: 'n', x: 510, is: { on: 'beside', panelId: 'w', side: 'after' } },
      { situation: 'a wide panel passing a narrow neighbour to its right', rows: wideThenNarrow, dragged: 'w', x: 520, is: { on: 'beside', panelId: 'n', side: 'after' } },
      { situation: 'the pointer still over the dragged panel', rows: equal, dragged: 'a', x: 290, is: null },
    ])('$situation', ({ rows, dragged, x, is }) => {
      expect(placementFor({ x, y: 50 }, rows, dragged)).toEqual(is);
    });

    it('goes after the farther of two neighbours the pointer is past', () => {
      const three = row(['a', 0, 196], ['b', 200, 396], ['c', 400, 600]);
      expect(placementFor({ x: 590, y: 50 }, three, 'a')).toEqual({ on: 'beside', panelId: 'c', side: 'after' });
      expect(placementFor({ x: 10, y: 50 }, three, 'c')).toEqual({ on: 'beside', panelId: 'a', side: 'before' });
    });

    it('still goes by halves over a panel on a different row', () => {
      const rows = drawn([['a', 'b'], ['c']]);
      expect(placementFor({ x: 10, y: 50 }, rows, 'c')).toEqual({ on: 'beside', panelId: 'a', side: 'before' });
      expect(placementFor({ x: 290, y: 50 }, rows, 'c')).toEqual({ on: 'beside', panelId: 'b', side: 'before' });
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
    const boards: { board: string[][]; spans: Spans }[] = [
      { board: [['a'], ['b'], ['c']], spans: {} },
      { board: [['a', 'b'], ['c']], spans: {} },
      { board: [['a'], ['b', 'c']], spans: {} },
      { board: [['a', 'b', 'c']], spans: {} },
      // Unequal widths, where a swap on entry has to be far enough in not to
      // put the panel back over the neighbour it just passed.
      { board: [['a', 'b']], spans: { a: 1, b: 3 } },
      { board: [['a', 'b']], spans: { a: 3, b: 1 } },
      { board: [['a', 'b', 'c']], spans: { a: 1, b: 4, c: 2 } },
      { board: [['a', 'b', 'c'], ['d']], spans: { a: 2, b: 1, c: 5 } },
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

    it.each(boards.flatMap(({ board, spans }) => board.flat().map((dragged) => ({ board, spans, dragged }))))(
      'settles anywhere on $board, widths $spans, while $dragged is in hand',
      ({ board, spans, dragged }) => {
        const from = stored(board, spans);

        for (const spot of everywhere(drawn(board, spans))) {
          let preview = from;
          const seen: string[] = [];
          // Four readings is generous: a move takes one, and the step the moved
          // rows buy takes another. A board still changing on the fourth is one
          // that is never going to stop.
          for (let reading = 0; reading < 4; reading += 1) {
            seen.push(JSON.stringify(lines(preview)));
            const placement = placementFor(spot, drawn(lines(preview), spans), dragged);
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

describe('Panels', () => {
  describe('a row held by its grip goes between the other rows as the pointer passes their middles', () => {
    // Three rows, 100 tall with 22 between: middles at 50, 172 and 294.
    const rows = drawn([['a'], ['b', 'c'], ['d']]);
    const MIDDLES = [50, 172, 294];

    it.each([
      { situation: 'the second of three, with the pointer above the first row’s middle', held: 'b', y: 40, place: 0 },
      { situation: 'the first of three, with the pointer past the last row’s middle', held: 'a', y: 300, place: 2 },
      { situation: 'the first of three, with the pointer short of the next row’s middle', held: 'a', y: 160, place: 0 },
      { situation: 'the last of three, with the pointer short of the row above’s middle', held: 'd', y: 180, place: 2 },
      { situation: 'the second of three, with the pointer on its own middle', held: 'b', y: MIDDLES[1]!, place: 1 },
      { situation: 'a row held by its second panel, which is the same row', held: 'c', y: 40, place: 0 },
    ])('puts $situation at $place', ({ held, y, place }) => {
      expect(rowPlacementFor(y, rows, held)).toBe(place);
    });

    it('asks for nothing where the row in hand is not on the board', () => {
      expect(rowPlacementFor(100, rows, 'gone')).toBeNull();
      expect(rowPlacementFor(100, [], 'a')).toBeNull();
    });

    it('asks for the arrangement with the row moved, from the one the drag started from', () => {
      const from = stored([['a'], ['b', 'c'], ['d']]);

      expect(lines(arrangedWithRow(from, 'a', 2))).toEqual([['b', 'c'], ['d'], ['a']]);
      expect(lines(arrangedWithRow(from, 'gone', 0))).toEqual(lines(from));
    });

    // The rule the Panel drag rests on, asked of a row in hand: held still, the
    // board comes to rest rather than trading two arrangements for ever.
    const boards = [
      [['a']],
      [['a'], ['b']],
      [['a'], ['b', 'c']],
      [['a'], ['b'], ['c']],
      [['a', 'b'], ['c'], ['d', 'e']],
    ];
    it.each(boards.flatMap((board) => board.map((row) => ({ board, held: row[0]! }))))(
      'settles anywhere on $board while the row of $held is in hand',
      ({ board, held }) => {
        const from = stored(board);
        const spots: number[] = [];
        for (let y = -20; y < board.length * 122 + 20; y += 7) spots.push(y);

        for (const y of spots) {
          let preview = from;
          const seen: string[] = [];
          for (let reading = 0; reading < 4; reading += 1) {
            seen.push(JSON.stringify(lines(preview)));
            const place = rowPlacementFor(y, drawn(lines(preview)), held);
            if (place === null) break;
            preview = arrangedWithRow(from, held, place);
          }
          expect(
            seen[seen.length - 1],
            `at y ${y} with the row of ${held} in hand, the board never came to rest: ${seen.join(' then ')}`,
          ).toEqual(JSON.stringify(lines(preview)));
        }
      },
    );
  });
});
