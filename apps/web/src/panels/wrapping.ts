/**
 * How a Dashboard row is drawn for the room it has ("Wrap a Dashboard row's
 * Panels instead of squeezing them", issue 1414).
 *
 * **Pure, for the reason `panelColumns.ts` is**: jsdom lays nothing out, so the
 * part that can be proved without a browser is the arithmetic over a width and
 * a count. The CSS grid draws what these say; that it does, and that nothing
 * scrolls sideways at any step, is `tests/e2e/panels.test.ts`.
 */

/**
 * The least a Panel is ever drawn: under about 220px a row of an Item can no
 * longer be drawn, because the flag, the due chip, the age and the menu never
 * shrink and the title is squeezed to nothing.
 */
export const LEAST_PANEL_WIDTH = 240;

/**
 * How many of a row's Panels sit side by side: as many as can each have
 * `LEAST_PANEL_WIDTH` with a gap between them, and never more than the row
 * has. One where nothing is measured, and one where not even two fit, so a row
 * narrower than a Panel still draws its Panel the full width.
 */
export function panelsPerLine(panels: number, width: number | null, gap: number): number {
  if (panels <= 1 || width === null || !(width > 0)) return 1;
  const fit = Math.floor((width + gap) / (LEAST_PANEL_WIDTH + gap));
  return Math.max(1, Math.min(panels, fit));
}

/** How many lines a row of `panels` Panels takes, `perLine` to a line. */
export function linesOf(panels: number, perLine: number): number {
  return Math.max(1, Math.ceil(panels / perLine));
}

/**
 * How many columns the last Panel spans: what is left of its line, so a short
 * last line is filled rather than left with a hole beside it. One for a row
 * that does not wrap, and for a last line that is full.
 */
export function lastPanelSpan(panels: number, perLine: number): number {
  if (panels <= perLine) return 1;
  return perLine - ((panels - 1) % perLine);
}

/**
 * The tracks of a row that does not wrap: each Panel keeps the share its
 * dividers gave it, but is never asked to be thinner than `LEAST_PANEL_WIDTH`,
 * and a gap track (a divider, where there is one to take hold of) between each.
 *
 * **A row of one Panel has no floor to keep**, so a row narrower than a Panel
 * is one track that fits rather than one that overflows: a row of several only
 * stays unwrapped where every Panel fits at its least.
 */
export function tracksOf(shares: readonly number[], gap: number): string {
  const least = shares.length > 1 ? `${LEAST_PANEL_WIDTH}px` : '0';
  return shares.map((share) => `minmax(${least}, ${share}fr)`).join(` ${gap}px `);
}

/** The tracks of a row that wraps: `perLine` equal columns. */
export function wrappedTracksOf(perLine: number): string {
  return `repeat(${perLine}, minmax(0, 1fr))`;
}
