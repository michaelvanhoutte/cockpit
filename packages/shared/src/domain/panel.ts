import { z } from 'zod';
import { workspaceNameSchema } from './item.js';

/**
 * Panels and the layouts that arrange them ("Panels on a dashboard, with
 * per-screen-size layouts", issue 33).
 *
 * A Panel is a movable, resizable, titled box on a Dashboard
 * (functional-definition.md, "Container hierarchy"). A Layout is one
 * arrangement of that Dashboard's Panels at one screen size.
 */

/** The grid every Dashboard is drawn on (architecture.md §4.4, "packages/shared: schema and command rationale", for why twelve). */
export const GRID_COLUMNS = 12;

/** The tallest and shortest a row may be set to, in pixels (architecture.md §4.4). */
export const MIN_ROW_HEIGHT = 160;
export const MAX_ROW_HEIGHT = 720;

/** The most Panels the gestures will put across one row (architecture.md §4.4). */
export const MOST_ACROSS = 4;

/** The share a Panel gets when nothing has said otherwise — an equal one (architecture.md §4.4). */
export const DEFAULT_CELL_SPAN = 12;

/** A Panel's title obeys exactly the rules a Workspace's and a Dashboard's name does (`workspaceNameSchema`). */
export const panelNameSchema = workspaceNameSchema;

/**
 * What a Panel is made of: the Items filed into it, or the text written in it
 * ("Put a panel of text on a dashboard, and write in it", issue 250);
 * architecture.md §4.4 — decided when the Panel is made and never after.
 */
export const PANEL_KINDS = ['items', 'text'] as const;
export const panelKindSchema = z.enum(PANEL_KINDS);
export type PanelKind = z.infer<typeof panelKindSchema>;

/**
 * Whether a Panel takes items filed onto it — every kind except one made of
 * text (issue 250). One function rather than the check written at each call
 * site — the server refusing a filing, the server offering panels to a
 * routing proposal, and the client's own picker — so they cannot come to
 * disagree about what a Panel will take, the same shape of rule
 * `refuseAPanelOfText` in `apps/api/src/accounts/command-service.ts` enforces.
 */
export function panelTakesItems(panel: { kind: PanelKind }): boolean {
  return panel.kind !== 'text';
}

/**
 * How a Panel of text's words are drawn: as the characters that were typed, or
 * as what they mean ("Format what a panel says, without making every
 * dashboard pay for an editor", issue 251); architecture.md §4.4 — not a
 * conversion either way, and `'plain'` is the default for performance.
 */
export const PANEL_FORMATS = ['plain', 'rich'] as const;
export const panelFormatSchema = z.enum(PANEL_FORMATS);
export type PanelFormat = z.infer<typeof panelFormatSchema>;

/** The most a Panel of text holds, matching a Description's own cap (architecture.md §4.4). Not trimmed, unlike a Description. */
export const PANEL_TEXT_LIMIT = 60_000;
export const panelTextSchema = z.string().max(PANEL_TEXT_LIMIT);

/**
 * A Panel, as it is read back. What a Panel *holds* is not here — a filing is
 * its own shape (`filingSchema` below), because an Item can be filed on
 * several Panels at once ("Panels hold the items filed into them, and the
 * Inbox holds the rest", issue 36; architecture.md §4.4).
 */
export const panelSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  dashboardId: z.string(),
  name: z.string(),
  /** Permissive read-back field; `.catch` also covers the field being absent (architecture.md §4.4). */
  kind: panelKindSchema.catch('items'),
  /** Whether that text is drawn as characters or as what they mean. Permissive like `kind`. */
  format: panelFormatSchema.catch('plain'),
  /** The Markdown of a Panel of text. Empty for a Panel of items. */
  body: z.string().default(''),
  /** Whether that text is read rather than written in — a property of the Panel, not of the viewer (architecture.md §4.4). */
  readOnly: z.boolean().default(false),
});
export type Panel = z.infer<typeof panelSchema>;

/** One Panel in one row of a layout, and how much of that row it takes — a share, not a width (architecture.md §4.4). */
export const layoutCellSchema = z.object({
  panelId: z.string(),
  span: z.number(),
});
export type LayoutCell = z.infer<typeof layoutCellSchema>;

/** One row of a layout: the Panels across it, in order, and how tall it is (architecture.md §4.4). */
export const layoutRowSchema = z.object({
  height: z.number().nullable().default(null),
  cells: z.array(layoutCellSchema),
});
export type LayoutRow = z.infer<typeof layoutRowSchema>;

/** One arrangement of a Dashboard's Panels, at one Screen size ("Draw a dashboard against the screen sizes its account has", issue 263; "Take the width and the name off a layout, now that its size carries them", issue 264; architecture.md §4.4). */
export const layoutSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  dashboardId: z.string(),
  /** The Screen size this Layout arranges the Dashboard for. */
  screenSizeId: z.string(),
  /** The rows, top to bottom, each holding its Panels left to right. */
  rows: z.array(layoutRowSchema).default([]),
});
export type Layout = z.infer<typeof layoutSchema>;

/** A cell on the way *in*, where the limits are real (architecture.md §4.4). */
export const cellInputSchema = z.object({
  panelId: z.string(),
  span: z.number().int().min(1).max(GRID_COLUMNS),
});
export type CellInput = z.infer<typeof cellInputSchema>;

/** A row on the way in. An empty one is refused (architecture.md §4.4). */
export const rowInputSchema = z.object({
  height: z.number().int().min(MIN_ROW_HEIGHT).max(MAX_ROW_HEIGHT).nullable(),
  cells: z.array(cellInputSchema).min(1),
});
export type RowInput = z.infer<typeof rowInputSchema>;

/**
 * One Item filed on one Panel, and where it sits in that Panel's order
 * (issue 36; architecture.md §4.4). An Item may be filed on as many Panels as
 * you like; the Inbox is the absence of a filing, not a Panel of its own.
 */
export const filingSchema = z.object({
  panelId: z.string(),
  itemId: z.string(),
  position: z.number(),
});
export type Filing = z.infer<typeof filingSchema>;
