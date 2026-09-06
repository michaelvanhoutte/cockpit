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
  | { on: 'ownRow'; at: number };

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
    if (point.y < row.top) return { on: 'ownRow', at: index };
    if (point.y <= row.bottom) {
      const placement = alongTheRow(point.x, row, index);
      return placement.on === 'beside' && placement.panelId === dragged ? null : placement;
    }
  }
  return { on: 'ownRow', at: rows.length };
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
  if (!last) return { on: 'ownRow', at: index };

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
  return placement.on === 'beside'
    ? movedBeside(rows, panelId, placement.panelId, placement.side)
    : movedToOwnRow(rows, panelId, placement.at);
}
