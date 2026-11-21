import { z } from 'zod';
import {
  commandEnvelopeSchema,
  deleteDashboardSchema,
  deletePanelSchema,
  moveItemToPanelSchema,
  removeChildSchema,
  removeItemFromPanelSchema,
  setDismissedSchema,
} from './commands.js';
import {
  CARDS_PUT_BACK_AT_ONCE,
  boardCoordinateSchema,
  boxLabelSchema,
  boxSizeSchema,
  dashboardViewSchema,
  lineKindNameSchema,
  lineLabelSchema,
  lineStyleSchema,
  splitShareSchema,
} from './domain/board.js';
import { swatchSchema } from './domain/swatches.js';

/**
 * The commands a Dashboard's whiteboard sends ("Brainstorming: give every
 * Dashboard a whiteboard of its own", issue 1829), registered beside
 * `commandSchemas` but kept in an entry point of their own
 * (`@cockpit/shared/board-commands`), outside the package's index, for the
 * reason `commands-combine.ts` gives. Every id is made by the tab, as a new
 * Item's is, so a resend names the same row.
 */

/**
 * place_card — an Item dragged onto a Dashboard's board becomes a card there.
 * Refused for an Item in the Inbox, which has to be filed on a Panel or put
 * inside an Item first, and for a Panel's own Item. An Item already on that
 * board keeps the card it has: nothing is written, and the answer is not
 * applied. Files nothing.
 */
export const placeCardSchema = commandEnvelopeSchema.extend({
  cardId: z.uuid(),
  dashboardId: z.string().min(1),
  itemId: z.uuid(),
  /** The box of that board it lands in, or null for open space. */
  boxId: z.uuid().nullable(),
  x: boardCoordinateSchema,
  y: boardCoordinateSchema,
});
export type PlaceCardCommand = z.infer<typeof placeCardSchema>;

/** move_card — a card dragged to a new place, into a box of its board or out onto open space. */
export const moveCardSchema = commandEnvelopeSchema.extend({
  cardId: z.uuid(),
  boxId: z.uuid().nullable(),
  x: boardCoordinateSchema,
  y: boardCoordinateSchema,
});
export type MoveCardCommand = z.infer<typeof moveCardSchema>;

/** take_card_off — a card taken off its board, the Item untouched; the Undo of placing one. Already off is as good as done. */
export const takeCardOffSchema = commandEnvelopeSchema.extend({ cardId: z.uuid() });
export type TakeCardOffCommand = z.infer<typeof takeCardOffSchema>;

/**
 * put_cards_back — cards taken off brought back where they were: the Undo of
 * taking one off, and the other half of the Undo of a change sent with
 * `takeCardsOff`, sent after the changes that give the Item its place back.
 * A card whose Item is in the Inbox or dismissed, whose Dashboard is gone, or
 * whose Item has another card on that board by now stays off; one whose box is
 * gone comes back on open space. Applied where any came back.
 */
export const putCardsBackSchema = commandEnvelopeSchema.extend({
  cardIds: z.array(z.uuid()).min(1).max(CARDS_PUT_BACK_AT_ONCE),
});
export type PutCardsBackCommand = z.infer<typeof putCardsBackSchema>;

/** draw_box — **Draw box**: a box with a name and a colour, on open space or inside another box of the same board. */
export const drawBoxSchema = commandEnvelopeSchema.extend({
  boxId: z.uuid(),
  dashboardId: z.string().min(1),
  parentBoxId: z.uuid().nullable(),
  label: boxLabelSchema,
  colour: swatchSchema.nullable(),
  x: boardCoordinateSchema,
  y: boardCoordinateSchema,
  w: boxSizeSchema,
  h: boxSizeSchema,
});
export type DrawBoxCommand = z.infer<typeof drawBoxSchema>;

/** move_box — a box dragged, with what it holds, to a new place: into another box of its board, never into itself or one it holds, or onto open space. */
export const moveBoxSchema = commandEnvelopeSchema.extend({
  boxId: z.uuid(),
  parentBoxId: z.uuid().nullable(),
  x: boardCoordinateSchema,
  y: boardCoordinateSchema,
});
export type MoveBoxCommand = z.infer<typeof moveBoxSchema>;

/** resize_box — a box's new frame: a corner dragged moves its top left as well as its size. */
export const resizeBoxSchema = commandEnvelopeSchema.extend({
  boxId: z.uuid(),
  x: boardCoordinateSchema,
  y: boardCoordinateSchema,
  w: boxSizeSchema,
  h: boxSizeSchema,
});
export type ResizeBoxCommand = z.infer<typeof resizeBoxSchema>;

/** rename_box — the name typed in a box's header. */
export const renameBoxSchema = commandEnvelopeSchema.extend({ boxId: z.uuid(), label: boxLabelSchema });
export type RenameBoxCommand = z.infer<typeof renameBoxSchema>;

/** set_box_colour — one of the eight swatches, or null for *None*. */
export const setBoxColourSchema = commandEnvelopeSchema.extend({ boxId: z.uuid(), colour: swatchSchema.nullable() });
export type SetBoxColourCommand = z.infer<typeof setBoxColourSchema>;

/** set_box_collapsed — *Collapse* to its header, or *Expand*. */
export const setBoxCollapsedSchema = commandEnvelopeSchema.extend({ boxId: z.uuid(), collapsed: z.boolean() });
export type SetBoxCollapsedCommand = z.infer<typeof setBoxCollapsedSchema>;

/** delete_box — *Delete box…*: the box, every box inside it to any depth and every card in any of them leave the board; the Items are untouched. */
export const deleteBoxSchema = commandEnvelopeSchema.extend({ boxId: z.uuid() });
export type DeleteBoxCommand = z.infer<typeof deleteBoxSchema>;

/**
 * restore_box — the Undo of `delete_box`: the box and everything that one
 * delete took with it come back, inside its parent box where that is still
 * there, else on open space. A card whose Item has since gone to the Inbox, been
 * dismissed or been placed again on that board stays off.
 */
export const restoreBoxSchema = commandEnvelopeSchema.extend({ boxId: z.uuid() });
export type RestoreBoxCommand = z.infer<typeof restoreBoxSchema>;

/** set_dashboard_view — one of the four layouts in the Dashboard bar, remembered per Dashboard. */
export const setDashboardViewSchema = commandEnvelopeSchema.extend({ dashboardId: z.string().min(1), view: dashboardViewSchema });
export type SetDashboardViewCommand = z.infer<typeof setDashboardViewSchema>;

/** set_dashboard_split — where the divider was let go, as the Panels pane's share; 0 or 1 is a pane dragged shut. */
export const setDashboardSplitSchema = commandEnvelopeSchema.extend({ dashboardId: z.string().min(1), splitShare: splitShareSchema });
export type SetDashboardSplitCommand = z.infer<typeof setDashboardSplitSchema>;

/**
 * link_items — a link drawn from one card's dot to another's ("Brainstorming:
 * the whiteboard can't show how Items connect", issue 1831): between two Items
 * of the Workspace, of one of its kinds. Refused for an Item linked to itself,
 * one of another Workspace or none yet, and a dismissed one. A link sent again,
 * or the same two Items already linked that way by that kind, writes nothing.
 */
export const linkItemsSchema = commandEnvelopeSchema
  .extend({ linkId: z.uuid(), fromItemId: z.uuid(), toItemId: z.uuid(), kindId: z.string().min(1) })
  .refine((cmd) => cmd.fromItemId !== cmd.toItemId, { message: 'An Item can’t be linked to itself.', path: ['toItemId'] });
export type LinkItemsCommand = z.infer<typeof linkItemsSchema>;

/** set_link_kind — a link given another of the Workspace's kinds. */
export const setLinkKindSchema = commandEnvelopeSchema.extend({ linkId: z.uuid(), kindId: z.string().min(1) });
export type SetLinkKindCommand = z.infer<typeof setLinkKindSchema>;

/** set_link_label — a link's own label, drawn in place of its kind's name; empty is none. */
export const setLinkLabelSchema = commandEnvelopeSchema.extend({ linkId: z.uuid(), label: lineLabelSchema });
export type SetLinkLabelCommand = z.infer<typeof setLinkLabelSchema>;

/** unlink_items — *Remove link*; already removed is as good as done. */
export const unlinkItemsSchema = commandEnvelopeSchema.extend({ linkId: z.uuid() });
export type UnlinkItemsCommand = z.infer<typeof unlinkItemsSchema>;

/** restore_link — the Undo of `unlink_items`: back, unless either Item has been dismissed or the two are linked that way again. */
export const restoreLinkSchema = commandEnvelopeSchema.extend({ linkId: z.uuid() });
export type RestoreLinkCommand = z.infer<typeof restoreLinkSchema>;

const lineKindFields = { name: lineKindNameSchema, style: lineStyleSchema, colour: swatchSchema, arrow: z.boolean() };

/** add_line_kind — *+ New kind…*: a name no live kind of the Workspace has, whatever its capitals. */
export const addLineKindSchema = commandEnvelopeSchema.extend({ kindId: z.uuid(), ...lineKindFields });
export type AddLineKindCommand = z.infer<typeof addLineKindSchema>;

/** edit_line_kind — an added kind renamed or redrawn; *Leads to* and *Related* are refused. */
export const editLineKindSchema = commandEnvelopeSchema.extend({ kindId: z.string().min(1), ...lineKindFields });
export type EditLineKindCommand = z.infer<typeof editLineKindSchema>;

/** delete_line_kind — an added kind deleted, its links *Related* from then on; *Leads to* and *Related* are refused. */
export const deleteLineKindSchema = commandEnvelopeSchema.extend({ kindId: z.string().min(1) });
export type DeleteLineKindCommand = z.infer<typeof deleteLineKindSchema>;

/** restore_line_kind — the Undo of `delete_line_kind`: back, with its links, unless a live kind has its name by now. */
export const restoreLineKindSchema = commandEnvelopeSchema.extend({ kindId: z.string().min(1) });
export type RestoreLineKindCommand = z.infer<typeof restoreLineKindSchema>;

/** draw_line — **Draw line**: a free line between two points of one Dashboard's board, with an optional label. */
export const drawLineSchema = commandEnvelopeSchema.extend({
  lineId: z.uuid(),
  dashboardId: z.string().min(1),
  x1: boardCoordinateSchema,
  y1: boardCoordinateSchema,
  x2: boardCoordinateSchema,
  y2: boardCoordinateSchema,
  label: lineLabelSchema,
});
export type DrawLineCommand = z.infer<typeof drawLineSchema>;

/** set_line_label — a free line's label typed; empty is none. */
export const setLineLabelSchema = commandEnvelopeSchema.extend({ lineId: z.uuid(), label: lineLabelSchema });
export type SetLineLabelCommand = z.infer<typeof setLineLabelSchema>;

/** delete_line — *Remove line*; already removed is as good as done. */
export const deleteLineSchema = commandEnvelopeSchema.extend({ lineId: z.uuid() });
export type DeleteLineCommand = z.infer<typeof deleteLineSchema>;

/** restore_line — the Undo of `delete_line`, while its Dashboard is there. */
export const restoreLineSchema = commandEnvelopeSchema.extend({ lineId: z.uuid() });
export type RestoreLineCommand = z.infer<typeof restoreLineSchema>;

/**
 * Whether a change that would leave an Item in the Inbox while it has cards
 * takes those cards off every board as well (an Item in the Inbox is never on a
 * whiteboard). Absent or false, such a change is refused naming the Items and
 * their Dashboards (`onWhiteboardsRefusalSchema`), which is what a tab of the
 * release before gets; true, the cards come off in the same step. A change
 * leaving no such Item ignores it.
 */
const takeCardsOff = { takeCardsOff: z.boolean().optional() };

/**
 * The changes that can leave an Item in the Inbox, each with `takeCardsOff`:
 * taking it off its last Panel, *Move to…* Inbox, taking it out of its last
 * parent, deleting the Panel or the Dashboard it was last filed on, and
 * dismissing the Item that last held it (dismissing an Item takes its own cards
 * off without asking, and bringing it back puts them back). Mounted in place of
 * the plain ones (`apps/api/src/http/app.ts`); a selection sends one per Item.
 */
export const takingCardsOffSchemas = {
  move_item_to_panel: moveItemToPanelSchema.safeExtend(takeCardsOff),
  remove_item_from_panel: removeItemFromPanelSchema.safeExtend(takeCardsOff),
  remove_child: removeChildSchema.safeExtend(takeCardsOff),
  set_dismissed: setDismissedSchema.safeExtend(takeCardsOff),
  delete_panel: deletePanelSchema.safeExtend(takeCardsOff),
  delete_dashboard: deleteDashboardSchema.safeExtend(takeCardsOff),
} as const;

export const boardCommandSchemas = {
  place_card: placeCardSchema,
  move_card: moveCardSchema,
  take_card_off: takeCardOffSchema,
  put_cards_back: putCardsBackSchema,
  draw_box: drawBoxSchema,
  move_box: moveBoxSchema,
  resize_box: resizeBoxSchema,
  rename_box: renameBoxSchema,
  set_box_colour: setBoxColourSchema,
  set_box_collapsed: setBoxCollapsedSchema,
  delete_box: deleteBoxSchema,
  restore_box: restoreBoxSchema,
  set_dashboard_view: setDashboardViewSchema,
  set_dashboard_split: setDashboardSplitSchema,
  link_items: linkItemsSchema,
  set_link_kind: setLinkKindSchema,
  set_link_label: setLinkLabelSchema,
  unlink_items: unlinkItemsSchema,
  restore_link: restoreLinkSchema,
  add_line_kind: addLineKindSchema,
  edit_line_kind: editLineKindSchema,
  delete_line_kind: deleteLineKindSchema,
  restore_line_kind: restoreLineKindSchema,
  draw_line: drawLineSchema,
  set_line_label: setLineLabelSchema,
  delete_line: deleteLineSchema,
  restore_line: restoreLineSchema,
  ...takingCardsOffSchemas,
} as const;
