import type { LayoutRow } from '@cockpit/shared';

/**
 * The arrangement the open board would save, published so **+ Panel**'s
 * Section is added to what is on screen ("Add, rename and delete a titled
 * Section on a Dashboard", issue 896). A Dashboard nobody has arranged is drawn
 * to the board's measured width, which only the board knows, and its first
 * Section makes its Layout from exactly those rows.
 *
 * Read when the Section is added rather than subscribed to, since nothing is
 * drawn from it.
 */
let published: { dashboardId: string; rows: readonly LayoutRow[] } | null = null;

export function publishBoardRows(dashboardId: string, rows: readonly LayoutRow[]): void {
  published = { dashboardId, rows };
}

/** Withdraws a board's rows, but only its own: the next board may already have published. */
export function withdrawBoardRows(dashboardId: string): void {
  if (published?.dashboardId === dashboardId) published = null;
}

/** The rows the board on screen would save for this Dashboard, or null where it is not on screen. */
export function boardRowsOf(dashboardId: string): readonly LayoutRow[] | null {
  return published?.dashboardId === dashboardId ? published.rows : null;
}
