import { PANEL_COLUMN_GAP, PANEL_COLUMN_WIDTHS, type PanelColumns } from '@cockpit/shared';
import { whereItWouldLand } from './dropAt';

/**
 * How a Panel's rows split into columns ("Split a wide Panel's rows into
 * columns, at a minimum width set in its settings", issue 1207).
 *
 * **Pure, for the reason `dropAt.ts` is**: jsdom lays nothing out, so the part
 * that can be proved without a browser is the arithmetic over a width and over
 * the rows' boxes. The CSS grid draws the columns; these say the same count and
 * the same landing place in words and numbers.
 */

/**
 * As many columns of at least `minimum` pixels, with a gap between each, as
 * `width` holds - and one when not even two fit. It is the count CSS's
 * `repeat(auto-fill, minmax(minimum, 1fr))` arrives at, so the form can promise
 * what the Panel will draw.
 */
export function columnsThatFit(width: number, minimum: number): number {
  return Math.max(1, Math.floor((width + PANEL_COLUMN_GAP) / (minimum + PANEL_COLUMN_GAP)));
}

/** The grid a Panel's list is drawn on, or none for one list. */
export function columnsStyle(columns: PanelColumns | null): React.CSSProperties | undefined {
  if (columns === null) return undefined;
  return {
    display: 'grid',
    // `min(100%, …)` so a Panel narrower than its minimum is one column that
    // fits rather than one that overflows.
    gridTemplateColumns: `repeat(auto-fill, minmax(min(100%, ${PANEL_COLUMN_WIDTHS[columns]}px), 1fr))`,
    columnGap: PANEL_COLUMN_GAP,
  };
}

/**
 * How wide a Panel draws its list, in pixels, or null when it is not on the
 * screen or draws at no width (a collapsed one) - measured, because a Panel's width is a share of its row and no
 * number the app holds.
 */
export function drawnWidthOf(panelId: string): number | null {
  const well = document.querySelector<HTMLElement>(`[data-panel-cell="${panelId}"] [data-drag-scroll="panel"]`);
  return well && well.clientWidth > 0 ? well.clientWidth : null;
}

/** A row's box on the screen. */
export interface RowBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Which gap a dragged row is over when the rows are in columns: 0 before the
 * first row, and the number of rows to land after all of them.
 *
 * **On a line of rows, by which half of the row the pointer is over** - before
 * it in the left half, after it in the right - and between two columns before
 * the next row along. Past the last row of a short line it lands after that
 * row. **Between lines, by height**, as in one column (`whereItWouldLand`), so
 * a pointer in the gap lands at the start of the line below it.
 */
export function landingAmongColumns(rows: readonly RowBox[], x: number, y: number): number {
  const onThisLine = rows
    .map((box, at) => ({ box, at }))
    .filter(({ box }) => y >= box.top && y < box.top + box.height);
  if (onThisLine.length > 0) {
    const next = onThisLine.find(({ box }) => x < box.left + box.width / 2);
    return next ? next.at : onThisLine[onThisLine.length - 1]!.at + 1;
  }
  return whereItWouldLand(
    rows.map((box) => box.top + box.height / 2),
    y,
  );
}
