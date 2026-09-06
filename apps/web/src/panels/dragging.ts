import type { LayoutRow } from '@cockpit/shared';
import { movedBeside, movedToOwnRow } from './arrangement';

/**
 * Where a panel would land if the drag ended here, worked out from where the
 * rows actually are on screen.
 *
 * Pure, and measured rather than guessed: the board hands it the rectangles it
 * read off the page and gets back a placement, so every rule about which row a
 * pointer is over and which side of a panel it fell on is provable without a
 * browser. What genuinely needs one - that the rectangles are where the page
 * put them - is the one thing arithmetic here cannot claim.
 */

/** One panel as it is drawn: which panel, and the horizontal band it occupies. */
export interface DrawnCell {
  panelId: string;
  left: number;
  right: number;
}

/** One row as it is drawn: the vertical band it occupies, and what is across it. */
export interface DrawnRow {
  top: number;
  bottom: number;
  cells: readonly DrawnCell[];
}

/**
 * Where the panel goes: beside another one on its row, or alone on a new row
 * at this gap.
 *
 * The two are the product's own two moves ("Panels on a dashboard, with
 * per-screen-size layouts", issue 33): drag onto a panel to join its row, or
 * into the gap between two rows to take a row of its own.
 */
export type Placement =
  | { on: 'beside'; panelId: string; side: 'before' | 'after' }
  /**
   * A row of its own, in the gap under the row this panel is on - or at the
   * very top, where there is no row above the gap.
   *
   * **Named by a panel rather than numbered**, and that is the whole of why
   * this type is shaped like this. The rows are measured as *drawn*, which is
   * the preview; the placement is applied to the arrangement the drag started
   * from. A panel's id means the same thing in both, and a row's index does
   * not - so a numbered gap read off the preview pointed at a different gap
   * in the arrangement it was applied to, the moment the drag had moved the
   * panel off the row it started on. It snapped the preview home and a
   * release there sent nothing.
   */
  | { on: 'ownRow'; under: string | null };

/**
 * The placement the pointer is asking for.
 *
 * **Inside a row means join it; between two rows means a row of its own.** The
 * gap is a real band while a drag is on - the board opens the seams to
 * something a hand can hit - so this is not asking the pointer to hit four
 * pixels.
 *
 * Above the first row and below the last are the gaps at either end, which is
 * what lets a panel be taken to the top or pushed past the bottom.
 *
 * **Null where the pointer is over the panel being dragged**, which is where
 * it spends most of a drag: the rows handed in are the rows *as drawn*, and
 * what is drawn already has the panel moved. A placement naming the panel
 * itself says the pointer is where the panel already is, so there is nothing
 * to change - and it cannot be expressed as a move either, since the
 * arrangement it would be applied to is the one the drag started from, where
 * beside-itself means nothing. Answered as "no change" here rather than left
 * for `movedBeside` to refuse: its refusal hands back the arrangement at
 * pick-up, which would throw the preview away and put the panel back where it
 * started, on any pointer position over the half of the row it had just
 * joined. A drop landing on one of those frames sent nothing at all.
 */
export function placementFor(
  point: { x: number; y: number },
  rows: readonly DrawnRow[],
  dragged: string,
): Placement | null {
  if (rows.length === 0) return null;

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    if (point.y < row.top) return inTheGapUnder(rows[index - 1], dragged);
    if (point.y <= row.bottom) {
      const placement = alongTheRow(point.x, row, index);
      return placement.on === 'beside' && placement.panelId === dragged ? null : placement;
    }
  }
  return inTheGapUnder(rows[rows.length - 1], dragged);
}

/**
 * A row of its own in the gap under `above`, named by the last panel on that
 * row - or at the top of the board, where the gap has no row above it.
 *
 * Null where that panel is the one being dragged, for the reason a slot
 * naming it is: the gap under a row the panel is already alone on is where it
 * already is, and there is nothing to change.
 */
function inTheGapUnder(above: DrawnRow | undefined, dragged: string): Placement | null {
  if (!above) return { on: 'ownRow', under: null };
  const last = above.cells[above.cells.length - 1];
  if (!last) return { on: 'ownRow', under: null };
  return last.panelId === dragged ? null : { on: 'ownRow', under: last.panelId };
}

/**
 * Which side of which panel the pointer fell on, for a row it is inside.
 *
 * The whole panel is one target rather than two halves of one: a half is a
 * comfortable thing to aim at, where the seam between two panels is four
 * pixels. Past the last panel is after it, which is how a panel reaches the end
 * of a row it is joining.
 */
function alongTheRow(x: number, row: DrawnRow, index: number): Placement {
  // A row with nothing across it is not a row the board draws, but a row whose
  // panels have all been deleted in another tab can be one for a frame.
  const last = row.cells[row.cells.length - 1];
  if (!last) return { on: 'ownRow', under: null };
  void index;

  for (const cell of row.cells) {
    if (x < cell.left + (cell.right - cell.left) / 2) {
      return { on: 'beside', panelId: cell.panelId, side: 'before' };
    }
  }
  return { on: 'beside', panelId: last.panelId, side: 'after' };
}

/**
 * The arrangement this placement would produce.
 *
 * The move functions already refuse what cannot happen - a row that is already
 * `MOST_ACROSS` across takes no more, and a panel asked for the line it is
 * already alone on stays put - and they refuse by handing back the arrangement
 * unchanged. That is what makes a preview honest: the board draws whatever
 * comes out of here, so a placement that would do nothing shows nothing
 * happening rather than promising a move that the drop then declines to make.
 */
export function arrangedWith(
  rows: readonly LayoutRow[],
  panelId: string,
  placement: Placement,
): LayoutRow[] {
  if (placement.on === 'beside') {
    return movedBeside(rows, panelId, placement.panelId, placement.side);
  }
  // The gap is named by the panel above it, so where that panel is *here* is
  // what decides which gap this is - the arrangement measured and the one
  // moved are two different arrangements, and only a panel means the same in
  // both. A panel that has gone since (deleted in another tab) leaves the
  // arrangement alone rather than guessing at a line.
  if (placement.under === null) return movedToOwnRow(rows, panelId, 0);
  const above = rows.findIndex((row) => row.cells.some((cell) => cell.panelId === placement.under));
  return above === -1 ? [...rows] : movedToOwnRow(rows, panelId, above + 1);
}
