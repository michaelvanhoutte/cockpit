import { z } from 'zod';
import { workspaceNameSchema } from './item.js';

/**
 * Panels and the layouts that arrange them ("Panels on a dashboard, with
 * per-screen-size layouts", issue 33).
 *
 * A Panel is a movable, resizable, titled box on a Dashboard (functional
 * definition, "Container hierarchy"). A Layout is one arrangement of that
 * Dashboard's Panels, remembering the screen width it was made at, so the same
 * Dashboard can read well on a phone and on a 4K screen.
 */

/**
 * The grid every Dashboard is drawn on, and the reason horizontal scrolling
 * cannot happen: the twelve columns are always the whole width of the page,
 * whatever that width is, so a Panel five columns wide is five twelfths of the
 * screen rather than a number of pixels that might not fit.
 *
 * That is also what "squeezed to fit" means in the issue. A layout made at
 * 2560px, opened on a 1280px screen, keeps every Panel's share of the width and
 * halves what that share measures - while the text inside keeps its own size,
 * because nothing here scales type.
 *
 * Twelve because it divides by one, two, three and four, which is the whole
 * range of "how many fit across" (see `panelsAcross` in apps/web) - a Panel is
 * then always a whole number of columns and a row never ends in a sliver.
 */
export const GRID_COLUMNS = 12;

/**
 * The tallest a Panel may be, in grid rows. A cap rather than no limit at all
 * because a row is a fixed height in pixels: without one, a resize could hand a
 * Panel a height no screen can show and nothing on the page would say why the
 * rest had vanished below it.
 */
export const MAX_PANEL_ROWS = 8;

/**
 * What a Panel is given when nothing has said otherwise - a new Panel appended
 * to a layout that has no Panel to copy from, and the arrangement a Dashboard
 * is drawn with before it has any layout at all.
 *
 * A third of the grid and three rows: wide enough to read a list in, short
 * enough that three of them do not fill a laptop screen on their own.
 */
export const DEFAULT_PANEL_SIZE = { columns: 4, rows: 3 } as const;

/**
 * A Panel's title obeys exactly the rules a Workspace's and a Dashboard's name
 * does, by being the same schema rather than a copy of it: required, trimmed,
 * single-line, at most 60 characters. What differs is only the scope
 * uniqueness is decided in - the Dashboard - and that is not a shape, so it is
 * not here.
 */
export const panelNameSchema = workspaceNameSchema;

/**
 * A Panel, as it is read back.
 *
 * `name`, `id` and `dashboardId` are the permissive `z.string()` for the reason
 * a Dashboard's are: this is the shape read back, and something stored before a
 * rule existed should still render rather than blanking the dashboard it sits
 * on.
 *
 * What a Panel *shows* is not here. It is configuration a Panel will grow with
 * "Render actions in panels, backed by one shared action list" (issue 36), and
 * the issue this file is for leaves it out on purpose: a Panel today is a box
 * with a title and a place on the grid.
 */
export const panelSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  dashboardId: z.string(),
  name: z.string(),
});
export type Panel = z.infer<typeof panelSchema>;

/**
 * Where one Panel sits in one layout: how many columns across and how many rows
 * down. Its position in the row is not stored, because Panels flow left to
 * right and wrap - the *order* of this list is the arrangement, which is what
 * makes dragging one Panel past another a reorder rather than a move to a
 * coordinate.
 *
 * Deliberately permissive numbers, for the reason the names above are
 * permissive: a stored span outside today's limits should be clamped by the
 * screen drawing it, not turn the whole snapshot into a parse failure. The
 * limits are on the way in, on `placementInputSchema` below.
 */
export const panelPlacementSchema = z.object({
  panelId: z.string(),
  columns: z.number(),
  rows: z.number(),
});
export type PanelPlacement = z.infer<typeof panelPlacementSchema>;

/**
 * One arrangement of a Dashboard's Panels, and the screen width it was made
 * for.
 *
 * `screenWidth` is the width the layout was created at, not a breakpoint: the
 * issue asks for arbitrary widths, so there is no fixed set to belong to and
 * "which layout is this screen's" is a question about distance rather than
 * about membership.
 */
export const layoutSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  dashboardId: z.string(),
  screenWidth: z.number(),
  /** In the order the Panels are drawn in, left to right and wrapping. */
  placements: z.array(panelPlacementSchema),
});
export type Layout = z.infer<typeof layoutSchema>;

/**
 * A placement on the way *in*, where the limits are real: a span outside the
 * grid is a request nothing could draw, so it is refused rather than clamped -
 * repairing input is where the bypasses live.
 */
export const placementInputSchema = z.object({
  panelId: z.string(),
  columns: z.number().int().min(1).max(GRID_COLUMNS),
  rows: z.number().int().min(1).max(MAX_PANEL_ROWS),
});
export type PlacementInput = z.infer<typeof placementInputSchema>;
