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
 * The tallest and shortest a row may be set to, in pixels.
 *
 * A cap for the reason the old per-Panel one existed: without it a drag could
 * hand a row a height no screen can show, and nothing on the page would say why
 * what follows it had vanished.
 *
 * **The floor is the header plus a list, not the header.** A Panel's header is
 * a fixed fifty-six pixels - its padding and its menu button - and it takes no
 * items, so a floor near twice that leaves a well of about one row: too little
 * to read, and too little to aim an item at. Filing one by dropping it on a
 * short Panel missed the list and hit the header, which is not a drop target.
 * A hundred and sixty leaves two rows under the header, which is the least that
 * still reads as a list.
 */
export const MIN_ROW_HEIGHT = 160;
export const MAX_ROW_HEIGHT = 720;

/**
 * The most Panels the gestures will put across one row.
 *
 * Four already means a 2560px screen giving each one 640px; past that they stop
 * being boxes you read and become a strip of columns. It is a rule about the
 * gestures rather than about the table - `cellInputSchema` says why - so a row
 * converted from an arrangement that wrapped six narrow Panels onto one line is
 * still drawn, six across.
 */
export const MOST_ACROSS = 4;

/**
 * The share a Panel gets when nothing has said otherwise, which is an equal one:
 * every cell of a row starts at the same span, so a row of three is three
 * thirds. Any value would do - the spans are read as proportions - and twelve
 * makes the whole numbers a divider drag moves between them the same twelfths
 * the grid was always drawn in.
 */
export const DEFAULT_CELL_SPAN = 12;

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
 * **What a Panel holds is not here either**, and that is deliberate rather than
 * unfinished: a Panel holds the Items filed into it ("Panels hold the items
 * filed into them, and the Inbox holds the rest", issue 36), and a filing is
 * its own shape (`filingSchema` below) because an Item can be filed on several
 * Panels at once. A Panel that carried its own list would carry the same Item
 * once per Panel.
 *
 * A rule for what *arrives* in a Panel without being filed is configuration it
 * does not have yet ("Panel configuration: connections and free-text
 * description", issue 35).
 */
export const panelSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  dashboardId: z.string(),
  name: z.string(),
});
export type Panel = z.infer<typeof panelSchema>;

/**
 * One Panel in one row of a layout, and how much of that row it takes.
 *
 * **The span is a share, not a width.** A row's Panels divide it in proportion
 * to their spans, so two cells of 6 and 6 take half each and so do two of 1 and
 * 1 - what a span means is only ever "this much of the row, next to those".
 * Requiring them to sum to twelve would be a second rule saying the same thing,
 * and it would have to be repaired every time a Panel joined a row or left one.
 *
 * Deliberately permissive, for the reason the names above are: a stored span
 * outside today's limits should be drawn by the screen rather than turn the
 * whole snapshot into a parse failure. The limits are on the way in, on
 * `cellInputSchema`.
 */
export const layoutCellSchema = z.object({
  panelId: z.string(),
  span: z.number(),
});
export type LayoutCell = z.infer<typeof layoutCellSchema>;

/**
 * One row of a layout: the Panels across it, in order, and how tall it is.
 *
 * **Every Panel in a row is the same height**, which is the row's, so height is
 * a property of the row rather than of each Panel in it - the thing a person
 * drags is the line under the row, and one number is what that gesture means.
 *
 * `height` is null for "as tall as what is in it", which is what a row is until
 * somebody says otherwise. Stored in pixels rather than in grid rows, because
 * the gesture that sets it is a pointer dragging an edge; there is no unit
 * between it and the screen for a number of rows to be worth.
 */
export const layoutRowSchema = z.object({
  height: z.number().nullable().default(null),
  cells: z.array(layoutCellSchema),
});
export type LayoutRow = z.infer<typeof layoutRowSchema>;

/**
 * A Layout's name obeys exactly the rules a Panel's title does, by being the
 * same schema: required, trimmed, single-line, at most 60 characters. What
 * differs is only the scope uniqueness is decided in - the Dashboard, the same
 * scope a Panel's title uses - and that is not a shape, so it is not here.
 */
export const layoutNameSchema = panelNameSchema;

/**
 * One arrangement of a Dashboard's Panels: what it is called, and the screen
 * width it was made at.
 *
 * **The name is what a person picks it by** ("Pick the layout you are on, by
 * name"). A Layout used to be identified by the width alone, which is a number
 * nobody recognises: *Made for 1463 px* says nothing about what the arrangement
 * is for, and the width it names is one a window is only accidentally.
 *
 * `screenWidth` is the width the Layout was created at, not a breakpoint, and
 * it is now only read when a screen is matched to a Layout: there is no fixed set of sizes
 * to belong to, so "which Layout is this screen's" is a question about distance
 * rather than about membership.
 *
 * **`name` is the permissive `z.string()`, and empty is a real value here.**
 * This is the shape read *back*, and a Layout written by the code serving
 * requests during the deploy that introduced the column carries no name at all;
 * the screen draws such a Layout as the width it was made for rather than
 * blanking the Dashboard it arranges. The rule that a name is required lives on
 * the way in, on `saveLayoutSchema` and `renameLayoutSchema`.
 */
export const layoutSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  dashboardId: z.string(),
  name: z.string().default(''),
  screenWidth: z.number(),
  /** The rows, top to bottom, each holding its Panels left to right. */
  rows: z.array(layoutRowSchema).default([]),
});
export type Layout = z.infer<typeof layoutSchema>;

/**
 * A cell on the way *in*, where the limits are real: a share of nothing, or of
 * more than a whole row, is a request nothing could draw, so it is refused
 * rather than clamped - repairing input is where the bypasses live.
 *
 * **How many cells a row may hold is not here**, and that is deliberate. Four
 * across is where a Panel stops being a box you read, so it is what the
 * gestures refuse; a row that already holds more - one converted from an
 * arrangement that wrapped six narrow Panels onto a line - is still a row, and
 * refusing to store it would mean refusing to store what somebody already had.
 */
export const cellInputSchema = z.object({
  panelId: z.string(),
  span: z.number().int().min(1).max(GRID_COLUMNS),
});
export type CellInput = z.infer<typeof cellInputSchema>;

/**
 * A row on the way in. An empty one is refused: a row is the Panels across it,
 * so a row with none is not an emptier arrangement but a line nothing draws.
 *
 * The height is bounded for the reason a layout's width is - one absurd value
 * would be a row no screen could show, and nothing on the page would say why
 * what follows it had vanished.
 */
export const rowInputSchema = z.object({
  height: z.number().int().min(MIN_ROW_HEIGHT).max(MAX_ROW_HEIGHT).nullable(),
  cells: z.array(cellInputSchema).min(1),
});
export type RowInput = z.infer<typeof rowInputSchema>;

/**
 * One Item filed on one Panel, and where it sits in that Panel's order
 * ("Panels hold the items filed into them, and the Inbox holds the rest",
 * issue 36).
 *
 * **An Item is filed on as many Panels as you like**, which is what makes a
 * Panel a view over one shared list rather than a folder: the same thing to do
 * can belong on *Project Falcon* and on *Anna* at once. Nothing here or in the
 * table behind it constrains an Item to one Panel.
 *
 * **The order is per Panel**, so one Item can be first on one and fifth on
 * another. It lives on the filing rather than on the Item for exactly that
 * reason - a single order shared by every Panel would mean reordering one
 * silently reordered the Panels you were not looking at.
 *
 * **The Inbox is the absence of these.** It is not a Panel with a row per Item;
 * it is every open Item filed nowhere, which is what makes filing an Item the
 * thing that takes it out of the Inbox.
 *
 * Deliberately permissive numbers and strings, for the reason the shapes above
 * are: this is what is read back, and a stored position outside today's limits
 * should be drawn rather than turning the whole snapshot into a parse failure.
 */
export const filingSchema = z.object({
  panelId: z.string(),
  itemId: z.string(),
  position: z.number(),
});
export type Filing = z.infer<typeof filingSchema>;
