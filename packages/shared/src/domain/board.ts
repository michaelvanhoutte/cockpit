import { z } from 'zod';
import { swatchSchema } from './swatches.js';

/**
 * A Dashboard's whiteboard ("Brainstorming: give every Dashboard a whiteboard
 * of its own", issue 1829): boxes you draw and cards you place, each one row of
 * its own, never a Panel and never an Item. A card is one Item placed on one
 * Dashboard's board, at most once; placing it files nothing and filing places
 * nothing.
 *
 * **Positions are in board units, as the board draws them.** A card or box
 * inside a box is placed relative to that box's top left corner; on open space,
 * relative to the board's origin.
 */

/** How far from the origin anything may sit, and how large a box may grow, in board units. */
export const BOARD_EXTENT = 1_000_000;
export const BOX_LABEL_MAX_LENGTH = 200;
/** How many cards one *put back* names at most: a selection's worth. */
export const CARDS_PUT_BACK_AT_ONCE = 100;

export const boardCoordinateSchema = z.number().min(-BOARD_EXTENT).max(BOARD_EXTENT);
export const boxSizeSchema = z.number().positive().max(BOARD_EXTENT);
export const boxLabelSchema = z.string().trim().max(BOX_LABEL_MAX_LENGTH);

/**
 * How a Dashboard is laid out, chosen from the four icons in its bar: its Panels
 * alone, Panels and whiteboard side by side or stacked, or the whiteboard alone.
 * Null, a Dashboard never switched, draws `panels`.
 */
export const DASHBOARD_VIEWS = ['panels', 'side', 'stacked', 'board'] as const;
export type DashboardView = (typeof DASHBOARD_VIEWS)[number];
export const dashboardViewSchema = z.enum(DASHBOARD_VIEWS);
/** The divider's place between the two panes, as the Panels pane's share of the width or height; null draws 0.4. */
export const DEFAULT_SPLIT_SHARE = 0.4;
export const splitShareSchema = z.number().min(0).max(1);

export const boardBoxSchema = z.object({
  id: z.string(),
  dashboardId: z.string(),
  /** The box it sits inside, to any depth; null on open space. */
  parentBoxId: z.string().nullable(),
  label: z.string(),
  colour: swatchSchema.nullable(),
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
  collapsed: z.boolean(),
});
export type BoardBox = z.infer<typeof boardBoxSchema>;

export const boardCardSchema = z.object({
  id: z.string(),
  dashboardId: z.string(),
  itemId: z.string(),
  /** The one box it sits in; null on open space. */
  boxId: z.string().nullable(),
  x: z.number(),
  y: z.number(),
});
export type BoardCard = z.infer<typeof boardCardSchema>;

/** A Dashboard's chosen layout and divider, for each Dashboard that has either. */
export const dashboardLayoutSchema = z.object({
  dashboardId: z.string(),
  view: dashboardViewSchema.nullable(),
  splitShare: z.number().nullable(),
});
export type DashboardLayout = z.infer<typeof dashboardLayoutSchema>;

/**
 * Every whiteboard of a Workspace, as its read carries them (`whiteboards`):
 * the live boxes and cards of each of its live Dashboards, and the layout of
 * each Dashboard that chose one. The Items the cards name are in the read's
 * `items` whatever their status, a finished one included, so a card is always
 * drawn from the Item's own row; a dismissed Item has no card. Every card of an
 * Item is on a Dashboard of its own Workspace, so *On whiteboards* is read from
 * here too.
 */
export const whiteboardsSchema = z.object({
  layouts: z.array(dashboardLayoutSchema),
  boxes: z.array(boardBoxSchema),
  cards: z.array(boardCardSchema),
});
export type Whiteboards = z.infer<typeof whiteboardsSchema>;

/**
 * The answer, with status 409, to a change that would send an Item with cards
 * to the Inbox without `takeCardsOff` (an Item in the Inbox is never on a
 * whiteboard): every such Item, and each card it has, with the Dashboard it is
 * on. Nothing was changed. Sent again with `takeCardsOff: true`, the change
 * takes those cards off in the same step, and `put_cards_back` with their ids
 * is its Undo's other half.
 */
export const onWhiteboardsRefusalSchema = z.object({
  error: z.string(),
  onWhiteboards: z.array(
    z.object({
      itemId: z.string(),
      title: z.string(),
      cards: z.array(z.object({ cardId: z.string(), dashboardId: z.string(), dashboardName: z.string() })),
    }),
  ),
});
export type OnWhiteboardsRefusal = z.infer<typeof onWhiteboardsRefusalSchema>;
export type ItemOnWhiteboards = OnWhiteboardsRefusal['onWhiteboards'][number];
