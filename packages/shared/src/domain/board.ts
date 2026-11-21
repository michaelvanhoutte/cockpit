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

/**
 * Links between Items, their line kinds, and free lines ("Brainstorming: the
 * whiteboard can't show how Items connect", issue 1831).
 *
 * **A link joins two Items of one Workspace**, never a box, and is shown on
 * every board holding a card for each. Its **line kind** is one of the
 * Workspace's list: a name, a style, one of the swatches and an arrowhead or
 * none. *Leads to* and *Related* are every Workspace's, can't be renamed or
 * deleted, and have an id made from the Workspace's (`fixedLineKindId`), so a
 * Workspace has them before anything is written. A link whose kind was deleted
 * is *Related*. **A free line** is drawn between two points of one Dashboard's
 * board, with an optional label, and belongs to that board alone.
 */
export const LINE_STYLES = ['solid', 'dashed', 'dotted', 'double'] as const;
export type LineStyle = (typeof LINE_STYLES)[number];
export const lineStyleSchema = z.enum(LINE_STYLES);

/** The two kinds every Workspace has, which can't be renamed or deleted. */
export const LINE_KIND_ROLES = ['leads_to', 'related'] as const;
export type LineKindRole = (typeof LINE_KIND_ROLES)[number];
export const LINE_KIND_NAME_MAX_LENGTH = 60;
export const LINE_LABEL_MAX_LENGTH = 200;
export const lineKindNameSchema = z.string().trim().min(1).max(LINE_KIND_NAME_MAX_LENGTH);
/** A link's or a free line's label; empty is none. */
export const lineLabelSchema = z.string().trim().max(LINE_LABEL_MAX_LENGTH);

export const lineKindSchema = z.object({
  id: z.string(),
  name: z.string(),
  style: lineStyleSchema,
  colour: swatchSchema,
  arrow: z.boolean(),
  /** `leads_to` or `related` for the two every Workspace has; null for one added. */
  role: z.enum(LINE_KIND_ROLES).nullable(),
});
export type LineKind = z.infer<typeof lineKindSchema>;

/** *Leads to* and *Related* as every Workspace starts with them. */
export const FIXED_LINE_KINDS: Record<LineKindRole, Omit<LineKind, 'id'>> = {
  leads_to: { name: 'Leads to', style: 'solid', colour: 'slate', arrow: true, role: 'leads_to' },
  related: { name: 'Related', style: 'solid', colour: 'grey', arrow: false, role: 'related' },
};

/** The id of one of the two kinds every Workspace has, made from the Workspace's own. */
export function fixedLineKindId(workspaceId: string, role: LineKindRole): string {
  return `${workspaceId}:${role === 'leads_to' ? 'leads-to' : 'related'}`;
}

/** A Workspace's kinds as it lists them: the two it always has first, then the ones added, oldest first. */
export function withFixedLineKinds(workspaceId: string, stored: readonly LineKind[]): LineKind[] {
  const fixed = LINE_KIND_ROLES.map(
    (role) => stored.find((kind) => kind.role === role) ?? { id: fixedLineKindId(workspaceId, role), ...FIXED_LINE_KINDS[role] },
  );
  return [...fixed, ...stored.filter((kind) => kind.role === null)];
}

export const itemLinkSchema = z.object({
  id: z.string(),
  fromItemId: z.string(),
  toItemId: z.string(),
  /** A live kind of the Workspace: one whose kind was deleted reads as *Related*. */
  kindId: z.string(),
  label: z.string().nullable(),
});
export type ItemLink = z.infer<typeof itemLinkSchema>;

export const boardLineSchema = z.object({
  id: z.string(),
  dashboardId: z.string(),
  x1: z.number(),
  y1: z.number(),
  x2: z.number(),
  y2: z.number(),
  label: z.string(),
});
export type BoardLine = z.infer<typeof boardLineSchema>;

/**
 * Every whiteboard of a Workspace, as its read carries them (`whiteboards`):
 * the live boxes, cards and free lines of each of its live Dashboards, and the
 * layout of each Dashboard that chose one. The Items the cards name are in the
 * read's `items` whatever their status, a finished one included, so a card is
 * always drawn from the Item's own row; a dismissed Item has no card. Every
 * card of an Item is on a Dashboard of its own Workspace, so *On whiteboards*
 * is read from here too. The links are those touching the Items the read
 * carries, between two Items neither dismissed, and the kinds are the
 * Workspace's, *Leads to* and *Related* first.
 */
export const whiteboardsSchema = z.object({
  layouts: z.array(dashboardLayoutSchema),
  boxes: z.array(boardBoxSchema),
  cards: z.array(boardCardSchema),
  lineKinds: z.array(lineKindSchema),
  links: z.array(itemLinkSchema),
  lines: z.array(boardLineSchema),
});
export type Whiteboards = z.infer<typeof whiteboardsSchema>;
