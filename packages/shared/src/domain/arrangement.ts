import { DEFAULT_CELL_SPAN, MOST_ACROSS, rowIsSection } from './panel.js';
import type { Layout, LayoutRow, Panel } from './panel.js';

/**
 * Which Panels a Dashboard draws and in what order ("Rows of panels, not a grid
 * that wraps"): the part of how a Dashboard is arranged that the browser and the
 * Worker both answer by - the order the Panels are read in, which is what Go to
 * panel lists them in and what a Panel read's list names them in. What moves a
 * Panel, and how a phone stacks them, stays the browser's (`apps/web/src/panels/arrangement.ts`).
 */

/**
 * How wide a panel wants to be before it stops being worth splitting a row
 * further. Not a breakpoint: it is only ever divided into the width the panels
 * have, to answer "how many fit across", so a screen of any width gets an
 * answer rather than falling into a bucket.
 *
 * 420px is about the width of a phone laid out at its comfortable size, and it
 * is what makes a phone one panel across (anything under 480px, `isPhoneWidth`,
 * and 480px itself), a 1280px laptop three, and anything wider four.
 *
 * What it is divided into is the width the *panels* have, not the window's:
 * where the Inbox sits beside them it takes about a fifth of the screen
 * ("Show the Inbox beside the dashboards instead of as a tab", issue 117), and
 * three across a 1280px screen would be three across nine hundred and ninety
 * pixels.
 */
export const COMFORTABLE_PANEL_WIDTH = 420;

/**
 * How many panels fit across a space this wide, at a size worth reading.
 *
 * **Only a dashboard nobody has arranged asks this.** Once there are rows, how
 * many panels are on a line is what somebody put there; this answers the one
 * case where nothing has been decided yet, and `MOST_ACROSS` caps it at the
 * same four the gestures refuse to exceed.
 *
 * Rounded rather than floored, which is not a detail: flooring asks how many
 * *whole* comfortable panels fit, so 790px - the width a dashboard has beside
 * the Inbox on a small laptop - would be one panel of 790 rather than two of
 * 395. Rounding picks the count whose panels land closest to comfortable, which
 * is the question actually being asked.
 */
export function panelsAcross(availableWidth: number): number {
  const wanted = Math.round(availableWidth / COMFORTABLE_PANEL_WIDTH);
  return Math.min(MOST_ACROSS, Math.max(1, wanted));
}

/**
 * The arrangement actually drawn: the layout's own rows, minus panels that are
 * no longer there, plus panels it has never heard of.
 *
 * Both halves are real. A panel deleted in another tab is gone from the
 * snapshot while this layout still names it, and a panel added in another tab
 * is in the snapshot while this layout does not - and a dashboard that dropped
 * a panel because one arrangement was stale would be hiding something a person
 * made.
 *
 * **A row emptied that way goes with its last panel**, because a row is the
 * panels across it and a blank line is not what a deleted panel should look
 * like. **A panel the layout has never heard of gets a row of its own**, for
 * the reason the server gives one to a panel added elsewhere
 * (apps/api/src/domain/panels.ts): nothing about a newcomer says which panels it
 * belongs beside.
 *
 * A dashboard with no layout at all is arranged for the screen it is on.
 */
export function drawnRows(
  layout: Layout | null,
  panels: readonly Panel[],
  availableWidth: number,
): LayoutRow[] {
  if (!layout) return fittedToScreen(panels, availableWidth);
  const live = new Set(panels.map((panel) => panel.id));
  // A Section holds no Panels and is kept as it is, with nothing under it too.
  const drawn = layout.rows
    .map((row) =>
      rowIsSection(row)
        ? { height: null, title: row.title, cells: [] }
        : { height: row.height, cells: row.cells.filter((cell) => live.has(cell.panelId)) },
    )
    .filter((row) => row.cells.length > 0 || rowIsSection(row));
  const seen = new Set(drawn.flatMap((row) => row.cells.map((cell) => cell.panelId)));
  for (const panel of panels) {
    if (seen.has(panel.id)) continue;
    drawn.push({ height: null, cells: [{ panelId: panel.id, span: DEFAULT_CELL_SPAN }] });
  }
  return drawn;
}

/**
 * The arrangement a dashboard with no layout is drawn with: the panels in the
 * order they were added, filling rows across the screen, each row's panels an
 * equal share of it.
 *
 * This is the one place the old wrapping rule survives, and it belongs here:
 * before anybody has arranged a dashboard there is nothing to say which panels
 * share a line, so how many fit at a size worth reading is the only answer
 * available. Every row after that is somebody's decision.
 *
 * No heights: a row that has never been dragged is as tall as what is on it.
 */
export function fittedToScreen(
  panels: readonly Panel[],
  availableWidth: number,
): LayoutRow[] {
  const across = panelsAcross(availableWidth);
  const rows: LayoutRow[] = [];
  for (let at = 0; at < panels.length; at += across) {
    rows.push({
      height: null,
      cells: panels
        .slice(at, at + across)
        .map((panel) => ({ panelId: panel.id, span: DEFAULT_CELL_SPAN })),
    });
  }
  return rows;
}
