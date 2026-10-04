import type { LayoutRow } from '@cockpit/shared';
import { movedBeside, movedRow, movedToOwnRow } from './arrangement';

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
      // On its own row a panel swaps once the pointer is where the swap would
      // draw it; on any other, which half of a panel the pointer is on decides.
      if (row.cells.some((cell) => cell.panelId === dragged)) {
        return withinItsOwnRow(point.x, row, dragged);
      }
      const placement = alongTheRow(point.x, row);
      if (!placement) return null;
      return placement.panelId === dragged ? null : placement;
    }
  }
  return inTheGapUnder(rows[rows.length - 1], dragged);
}

/**
 * Where the pointer asks the dragged panel to go on the row it is already on.
 *
 * **A swap happens when the pointer is where the swap would draw the panel**,
 * not at the neighbour's middle: moving past a neighbour puts the panel's far
 * edge where the neighbour's was, so the pointer is under the panel again once
 * it is at least a panel's width in from that edge. Two equal panels therefore
 * swap on entry, and a narrow one passing a wide one waits until it would land
 * under the pointer rather than back over the neighbour, where it would flip
 * straight back. The farthest neighbour the pointer has passed wins.
 *
 * Null while the pointer is over the dragged panel itself, for the reason
 * `placementFor` gives.
 */
function withinItsOwnRow(x: number, row: DrawnRow, dragged: string): Placement | null {
  const own = row.cells.find((cell) => cell.panelId === dragged);
  if (!own || (x >= own.left && x <= own.right)) return null;
  const width = own.right - own.left;
  if (x > own.right) {
    const passed = row.cells.filter((cell) => cell.left >= own.right && x >= cell.right - width);
    const farthest = passed[passed.length - 1];
    return farthest ? { on: 'beside', panelId: farthest.panelId, side: 'after' } : null;
  }
  const passed = row.cells.filter((cell) => cell.right <= own.left && x <= cell.left + width);
  const farthest = passed[0];
  return farthest ? { on: 'beside', panelId: farthest.panelId, side: 'before' } : null;
}

/**
 * A row of its own in the gap under `above`, named by a panel on that row - or
 * at the top of the board, where the gap has no row above it.
 *
 * **Named by a panel that is not the one being dragged**, which is the whole
 * rule and the one this got wrong three times. The row above is the row as
 * *drawn*, and what is drawn already has the dragged panel moved; the placement
 * is applied to the arrangement the drag started from. Every panel means the
 * same thing in both - except that one, which is the only thing the drag has
 * moved. Naming the gap after it resolved, in the arrangement being moved, to
 * the line the panel was already on, so the preview snapped home and a release
 * sent nothing.
 *
 * So the anchor is the last panel up there that is not the one in hand, and a
 * row holding nothing else is the row the panel already has to itself - which
 * is where it already is, and nothing to change.
 */
function inTheGapUnder(above: DrawnRow | undefined, dragged: string): Placement | null {
  if (!above) return { on: 'ownRow', under: null };
  const anchor = [...above.cells].reverse().find((cell) => cell.panelId !== dragged);
  return anchor ? { on: 'ownRow', under: anchor.panelId } : null;
}

/**
 * Which side of which panel the pointer fell on, for a row it is inside.
 *
 * The whole panel is one target rather than two halves of one: a half is a
 * comfortable thing to aim at, where the seam between two panels is four
 * pixels. Past the last panel is after it, which is how a panel reaches the end
 * of a row it is joining.
 */
function alongTheRow(
  x: number,
  row: DrawnRow,
): (Placement & { on: 'beside' }) | null {
  // A row with nothing across it is not a row the board draws, but a row whose
  // panels have all been deleted in another tab can be one for a frame. Asking
  // for nothing rather than for the top of the board: a row coming apart is no
  // reason to move the panel in hand somewhere nobody pointed at.
  const last = row.cells[row.cells.length - 1];
  if (!last) return null;

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

/**
 * Where a row held by its grip goes: its place among the rows once it is moved.
 *
 * **It passes a row when the pointer passes that row's middle** - the place is
 * the number of the *other* rows whose middle is above the pointer. Counting
 * the others rather than comparing with the neighbour is what lets a held
 * pointer come to rest: moving the row only shifts the others on the side it
 * has crossed, and they stay on the side of the pointer they were already on.
 *
 * Null where the row in hand is not on the board - deleted in another tab.
 */
export function rowPlacementFor(
  pointY: number,
  rows: readonly DrawnRow[],
  dragged: string,
): number | null {
  const holds = (row: DrawnRow) => row.cells.some((cell) => cell.panelId === dragged);
  if (!rows.some(holds)) return null;
  return rows.filter((row) => !holds(row) && (row.top + row.bottom) / 2 < pointY).length;
}

/**
 * The arrangement with the row holding `panelId` moved to `place`. A row has
 * no identity of its own, so it is named by a panel on it - which a row drag
 * never moves, so it means the same row in the preview and in the arrangement
 * the drag started from.
 */
export function arrangedWithRow(
  rows: readonly LayoutRow[],
  panelId: string,
  place: number,
): LayoutRow[] {
  const from = rows.findIndex((row) => row.cells.some((cell) => cell.panelId === panelId));
  return from === -1 ? [...rows] : movedRow(rows, from, place);
}
