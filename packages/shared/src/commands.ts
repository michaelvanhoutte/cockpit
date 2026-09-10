import { z } from 'zod';
import {
  associationKindSchema,
  dashboardNameSchema,
  itemDescriptionSchema,
  itemReadingSchema,
  itemTitleSchema,
  prioritySchema,
  workspaceNameSchema,
} from './domain/item.js';
import { itemTypeColorSchema, itemTypeNameSchema } from './domain/item-type.js';
import {
  panelFormatSchema,
  panelKindSchema,
  panelNameSchema,
  panelTextSchema,
  rowInputSchema,
} from './domain/panel.js';
import { MAX_SCREEN_WIDTH, MIN_SCREEN_WIDTH, screenSizeNameSchema } from './domain/screen-size.js';
import { hexColorSchema } from './domain/workspace-themes.js';

/**
 * Mutations are commands, not object PUTs (architecture.md, "Mutations are
 * commands, not object PUTs"). Every command carries a client-generated command
 * ID (idempotent retries) and the client timestamp (last-write-wins conflict
 * resolution).
 */
export const commandEnvelopeSchema = z.object({
  commandId: z.uuid(),
  /** Client wall-clock time when the command was issued. */
  issuedAt: z.iso.datetime(),
  workspaceId: z.string(),
});

/**
 * create_workspace (architecture.md §4.4, "packages/shared: schema and command
 * rationale"). `workspaceId` *is* the new workspace's id; `panelId` its first
 * panel's, for the same client-generated-uuid reason.
 */
export const createWorkspaceSchema = commandEnvelopeSchema.extend({
  workspaceId: z.uuid(),
  panelId: z.uuid(),
  name: workspaceNameSchema,
});
export type CreateWorkspaceCommand = z.infer<typeof createWorkspaceSchema>;

/** rename_workspace (architecture.md §4.4). */
export const renameWorkspaceSchema = commandEnvelopeSchema.extend({
  name: workspaceNameSchema,
});
export type RenameWorkspaceCommand = z.infer<typeof renameWorkspaceSchema>;

/** delete_workspace (architecture.md §4.4). */
export const deleteWorkspaceSchema = commandEnvelopeSchema;
export type DeleteWorkspaceCommand = z.infer<typeof deleteWorkspaceSchema>;

/** reorder_workspaces — the whole order, not the move that produced it (architecture.md §4.4, "a whole order, never a relative move"). */
export const reorderWorkspacesSchema = commandEnvelopeSchema
  .extend({
    workspaceIds: z.array(z.string().min(1)).min(1),
  })
  .refine((cmd) => new Set(cmd.workspaceIds).size === cmd.workspaceIds.length, {
    message: 'a workspace can only be in one place in the order',
    path: ['workspaceIds'],
  })
  .refine((cmd) => cmd.workspaceIds.includes(cmd.workspaceId), {
    message: 'the workspace that moved is not in the order',
    path: ['workspaceIds'],
  });
export type ReorderWorkspacesCommand = z.infer<typeof reorderWorkspacesSchema>;

/**
 * set_workspace_theme — all four colors together (architecture.md §4.4). The
 * server refuses a set that is not one of the eight palette entries
 * (`hexColorSchema` only validates `#rrggbb` shape, not membership).
 */
export const setWorkspaceThemeSchema = commandEnvelopeSchema.extend({
  color: hexColorSchema,
  bar: hexColorSchema,
  ground: hexColorSchema,
  header: hexColorSchema,
});
export type SetWorkspaceThemeCommand = z.infer<typeof setWorkspaceThemeSchema>;

/** add_dashboard (architecture.md §4.4). */
export const addDashboardSchema = commandEnvelopeSchema.extend({
  dashboardId: z.uuid(),
  /** The panel it arrives with, for the reason `create_workspace` carries one. */
  panelId: z.uuid(),
  name: dashboardNameSchema,
});
export type AddDashboardCommand = z.infer<typeof addDashboardSchema>;

/** rename_dashboard (architecture.md §4.4). */
export const renameDashboardSchema = commandEnvelopeSchema.extend({
  dashboardId: z.string(),
  name: dashboardNameSchema,
});
export type RenameDashboardCommand = z.infer<typeof renameDashboardSchema>;

/** delete_dashboard (architecture.md §4.4). */
export const deleteDashboardSchema = commandEnvelopeSchema.extend({
  dashboardId: z.string(),
});
export type DeleteDashboardCommand = z.infer<typeof deleteDashboardSchema>;

/** add_panel (architecture.md §4.4). */
export const addPanelSchema = commandEnvelopeSchema.extend({
  dashboardId: z.string(),
  panelId: z.uuid(),
  name: panelNameSchema,
  /** Defaulted rather than required, so a client that has never heard of kinds adds the panel it always added. */
  kind: panelKindSchema.default('items'),
});
export type AddPanelCommand = z.infer<typeof addPanelSchema>;

/** rename_panel (architecture.md §4.4). */
export const renamePanelSchema = commandEnvelopeSchema.extend({
  panelId: z.uuid(),
  name: panelNameSchema,
});
export type RenamePanelCommand = z.infer<typeof renamePanelSchema>;

/** delete_panel (architecture.md §4.4). */
export const deletePanelSchema = commandEnvelopeSchema.extend({
  panelId: z.uuid(),
});
export type DeletePanelCommand = z.infer<typeof deletePanelSchema>;

/** set_panel_text — the whole text of a Panel of text, as it now reads (architecture.md §4.4). */
export const setPanelTextSchema = commandEnvelopeSchema.extend({
  panelId: z.uuid(),
  body: panelTextSchema,
});
export type SetPanelTextCommand = z.infer<typeof setPanelTextSchema>;

/** set_panel_read_only — whether a Panel of text is read or written in. */
export const setPanelReadOnlySchema = commandEnvelopeSchema.extend({
  panelId: z.uuid(),
  readOnly: z.boolean(),
});
export type SetPanelReadOnlyCommand = z.infer<typeof setPanelReadOnlySchema>;

/** set_panel_format — how a Panel of text's words are drawn, not what they are (architecture.md §4.4). */
export const setPanelFormatSchema = commandEnvelopeSchema.extend({
  panelId: z.uuid(),
  format: panelFormatSchema,
});
export type SetPanelFormatCommand = z.infer<typeof setPanelFormatSchema>;

/**
 * save_layout — one arrangement of a dashboard's panels, whole (architecture.md
 * §4.4). Still an upsert: a `layoutId` the dashboard already has updates that
 * layout, a fresh client-generated one creates it.
 */
export const saveLayoutSchema = commandEnvelopeSchema.extend({
  dashboardId: z.string(),
  layoutId: z.uuid(),
  /** Bounded so a layout can never record a width no screen has (architecture.md §4.4). */
  screenWidth: z.number().int().min(1).max(100_000),
  /**
   * Which screen size this save defines a Layout for. Optional: left out, the
   * size is resolved on the way in to the account's nearest size, or one
   * called *Default* at `screenWidth` where the account has none at all —
   * sent explicitly, it means *Define a layout for X* (architecture.md §4.4).
   */
  screenSizeId: z.string().min(1).optional(),
  /** The rows, top to bottom. An arrangement is the whole list. */
  rows: z
    .array(rowInputSchema)
    // One cell per panel, across the whole layout rather than within a row (architecture.md §4.4).
    .refine(
      (rows) => {
        const panelIds = rows.flatMap((row) => row.cells.map((cell) => cell.panelId));
        return new Set(panelIds).size === panelIds.length;
      },
      { message: 'a panel appears once in a layout' },
    ),
});
export type SaveLayoutCommand = z.infer<typeof saveLayoutSchema>;

/** delete_layout — which layout; the panels stay where they are (architecture.md §4.4). */
export const deleteLayoutSchema = commandEnvelopeSchema.extend({
  layoutId: z.uuid(),
});
export type DeleteLayoutCommand = z.infer<typeof deleteLayoutSchema>;

/** create_screen_size — name and width, both typed by hand (architecture.md §4.4). */
export const createScreenSizeSchema = commandEnvelopeSchema.extend({
  screenSizeId: z.uuid(),
  name: screenSizeNameSchema,
  width: z.number().int().min(MIN_SCREEN_WIDTH).max(MAX_SCREEN_WIDTH),
});
export type CreateScreenSizeCommand = z.infer<typeof createScreenSizeSchema>;

/** rename_screen_size (architecture.md §4.4). */
export const renameScreenSizeSchema = commandEnvelopeSchema.extend({
  screenSizeId: z.string().min(1),
  name: screenSizeNameSchema,
});
export type RenameScreenSizeCommand = z.infer<typeof renameScreenSizeSchema>;

/** delete_screen_size — every layout at that size goes with it, account-wide (architecture.md §4.4). */
export const deleteScreenSizeSchema = commandEnvelopeSchema.extend({
  screenSizeId: z.string().min(1),
});
export type DeleteScreenSizeCommand = z.infer<typeof deleteScreenSizeSchema>;

/**
 * capture_item — the one command with many front doors (architecture.md,
 * "Multi-channel capture and the task-creator merge"; §4.4 for the payload).
 */
export const captureItemSchema = commandEnvelopeSchema.extend({
  itemId: z.uuid(),
  /** Capped where a description is capped, on the way in only (architecture.md §4.4). */
  message: z.string().trim().min(1).max(60_000),
  nextAction: z.string().optional(),
  /** Required — every Item has a Type ("Capture a thought or an action, and see which it is", issue 155; architecture.md §4.4). */
  typeId: z.string().min(1),
  /**
   * Whether the envelope's Workspace is where this Item belongs, or merely
   * where it was captured from ("Capture something before you know which
   * workspace it belongs to", issue 165). Defaults to true when left out, so
   * every front door that captures into a named workspace keeps saying what
   * it always said (architecture.md §4.4).
   */
  workspaceDecided: z.boolean().optional(),
});
export type CaptureItemCommand = z.infer<typeof captureItemSchema>;

/** create_item_type — made only from the types-management page ("Make a type where types are managed, not while capturing", issue 203; architecture.md §4.4). */
export const createItemTypeSchema = commandEnvelopeSchema.extend({
  typeId: z.uuid(),
  name: itemTypeNameSchema,
});
export type CreateItemTypeCommand = z.infer<typeof createItemTypeSchema>;

/** rename_item_type ("Manage the types, and put them in the order you want", issue 156; architecture.md §4.4). */
export const renameItemTypeSchema = commandEnvelopeSchema.extend({
  typeId: z.string().min(1),
  name: itemTypeNameSchema,
});
export type RenameItemTypeCommand = z.infer<typeof renameItemTypeSchema>;

export const setItemTypeColorSchema = commandEnvelopeSchema.extend({
  typeId: z.string().min(1),
  color: itemTypeColorSchema,
});
export type SetItemTypeColorCommand = z.infer<typeof setItemTypeColorSchema>;

/** delete_item_type — its Items are left where they are and simply stop having a type. */
export const deleteItemTypeSchema = commandEnvelopeSchema.extend({
  typeId: z.string().min(1),
});
export type DeleteItemTypeCommand = z.infer<typeof deleteItemTypeSchema>;

/** reorder_item_types — the whole order, not the move that produced it (architecture.md §4.4). */
export const reorderItemTypesSchema = commandEnvelopeSchema
  .extend({
    typeId: z.string().min(1),
    typeIds: z.array(z.string().min(1)).min(1),
  })
  .refine((cmd) => new Set(cmd.typeIds).size === cmd.typeIds.length, {
    message: 'a type can only be in one place in the order',
    path: ['typeIds'],
  })
  .refine((cmd) => cmd.typeIds.includes(cmd.typeId), {
    message: 'the type that moved is not in the order',
    path: ['typeIds'],
  });
export type ReorderItemTypesCommand = z.infer<typeof reorderItemTypesSchema>;

/**
 * An order names each Item once. Shared by the two commands below that carry
 * one, because it is the same rule (architecture.md §4.4, "a whole order").
 */
const namesEachItemOnce = (cmd: { order: string[] }) =>
  new Set(cmd.order).size === cmd.order.length;
const ONCE = { message: 'an item can only be in one place in the order', path: ['order'] };

/** move_item_to_panel — where an Item lives now, and the target Panel's whole order ("Panels hold the items filed into them, and the Inbox holds the rest", issue 36; architecture.md §4.4). */
export const moveItemToPanelSchema = commandEnvelopeSchema
  .extend({
    itemId: z.uuid(),
    /** The Panel it lands on, or null for the Inbox. */
    panelId: z.uuid().nullable(),
    /** Every Item on that Panel afterwards, in order. Empty for the Inbox. */
    order: z.array(z.uuid()),
  })
  .refine(namesEachItemOnce, ONCE)
  .refine((cmd) => (cmd.panelId === null ? cmd.order.length === 0 : cmd.order.includes(cmd.itemId)), {
    message: 'the item that moved is not in the order of the panel it moved to',
    path: ['order'],
  });
export type MoveItemToPanelCommand = z.infer<typeof moveItemToPanelSchema>;

/** add_item_to_panel — `move_item_to_panel` without the taking-off ("Ask whether to move an item to a panel or add it to one", issue 142; architecture.md §4.4). */
export const addItemToPanelSchema = commandEnvelopeSchema
  .extend({
    itemId: z.uuid(),
    panelId: z.uuid(),
    order: z.array(z.uuid()),
  })
  .refine(namesEachItemOnce, ONCE)
  .refine((cmd) => cmd.order.includes(cmd.itemId), {
    message: 'the item that arrived is not in the order of the panel it arrived on',
    path: ['order'],
  });
export type AddItemToPanelCommand = z.infer<typeof addItemToPanelSchema>;

/** remove_item_from_panel — not a delete, and not a move (issue 142; architecture.md §4.4). */
export const removeItemFromPanelSchema = commandEnvelopeSchema.extend({
  itemId: z.uuid(),
  panelId: z.uuid(),
});
export type RemoveItemFromPanelCommand = z.infer<typeof removeItemFromPanelSchema>;

/** set_done — a flag rather than a pair of commands each way ("An item is either yours to deal with or finished with", issue 154; architecture.md §4.4). */
export const setDoneSchema = commandEnvelopeSchema.extend({
  itemId: z.uuid(),
  done: z.boolean(),
});
export type SetDoneCommand = z.infer<typeof setDoneSchema>;

export const setDismissedSchema = commandEnvelopeSchema.extend({
  itemId: z.uuid(),
  dismissed: z.boolean(),
});
export type SetDismissedCommand = z.infer<typeof setDismissedSchema>;

export const associateSchema = commandEnvelopeSchema.extend({
  associationId: z.uuid(),
  itemId: z.uuid(),
  kind: associationKindSchema,
  label: z.string().min(1),
  /** true removes the association instead of adding it. */
  remove: z.boolean().optional(),
});
export type AssociateCommand = z.infer<typeof associateSchema>;

export const setNextActionSchema = commandEnvelopeSchema.extend({
  itemId: z.uuid(),
  nextAction: z.string(),
});
export type SetNextActionCommand = z.infer<typeof setNextActionSchema>;

export const setPrioritySchema = commandEnvelopeSchema.extend({
  itemId: z.uuid(),
  priority: prioritySchema.nullable(),
});
export type SetPriorityCommand = z.infer<typeof setPrioritySchema>;

/** set_title / set_description — two commands rather than one save ("Edit an item's title and description on a form of its own", issue 159; architecture.md §4.4). */
export const setTitleSchema = commandEnvelopeSchema.extend({
  itemId: z.uuid(),
  title: itemTitleSchema,
});
export type SetTitleCommand = z.infer<typeof setTitleSchema>;

export const setDescriptionSchema = commandEnvelopeSchema.extend({
  itemId: z.uuid(),
  description: itemDescriptionSchema.nullable(),
});
export type SetDescriptionCommand = z.infer<typeof setDescriptionSchema>;

/**
 * propose_item_texts — one command for both texts, sent by the enrichment job
 * rather than a client ("Clean up a captured note into a clear title and a
 * fuller message", issue 296; architecture.md §4.4, "two commands carry no
 * client and no route").
 */
export const proposeItemTextsSchema = commandEnvelopeSchema.extend({
  itemId: z.uuid(),
  title: itemTitleSchema.refine((title) => title.length > 0, {
    message: 'a proposed title has to name the note',
  }),
  description: itemDescriptionSchema.min(1),
  /** The other ways this note could genuinely be read ("Offer the other readings when a captured note says two things", issue 297); empty where there is only the one. */
  readings: z.array(itemReadingSchema),
});
export type ProposeItemTextsCommand = z.infer<typeof proposeItemTextsSchema>;

/**
 * propose_item_panel — the Panel Cockpit thinks a captured note belongs on,
 * offered rather than filed ("Propose where a captured note belongs, without
 * filing it there", issue 298; architecture.md §4.4).
 */
export const proposeItemPanelSchema = commandEnvelopeSchema.extend({
  itemId: z.uuid(),
  panelId: z.uuid(),
  reason: z.string().trim().min(1),
});
export type ProposeItemPanelCommand = z.infer<typeof proposeItemPanelSchema>;

/**
 * The command registry: name → payload schema. The API mounts one POST route
 * per entry; the client gets a typed sender per entry. Adding a command means
 * adding it here and writing its domain handler; no other wiring.
 */
export const commandSchemas = {
  create_workspace: createWorkspaceSchema,
  rename_workspace: renameWorkspaceSchema,
  delete_workspace: deleteWorkspaceSchema,
  reorder_workspaces: reorderWorkspacesSchema,
  set_workspace_theme: setWorkspaceThemeSchema,
  add_dashboard: addDashboardSchema,
  rename_dashboard: renameDashboardSchema,
  delete_dashboard: deleteDashboardSchema,
  add_panel: addPanelSchema,
  rename_panel: renamePanelSchema,
  delete_panel: deletePanelSchema,
  set_panel_text: setPanelTextSchema,
  set_panel_read_only: setPanelReadOnlySchema,
  set_panel_format: setPanelFormatSchema,
  save_layout: saveLayoutSchema,
  delete_layout: deleteLayoutSchema,
  create_screen_size: createScreenSizeSchema,
  rename_screen_size: renameScreenSizeSchema,
  delete_screen_size: deleteScreenSizeSchema,
  capture_item: captureItemSchema,
  create_item_type: createItemTypeSchema,
  rename_item_type: renameItemTypeSchema,
  set_item_type_color: setItemTypeColorSchema,
  delete_item_type: deleteItemTypeSchema,
  reorder_item_types: reorderItemTypesSchema,
  move_item_to_panel: moveItemToPanelSchema,
  add_item_to_panel: addItemToPanelSchema,
  remove_item_from_panel: removeItemFromPanelSchema,
  set_done: setDoneSchema,
  set_dismissed: setDismissedSchema,
  associate: associateSchema,
  set_next_action: setNextActionSchema,
  set_priority: setPrioritySchema,
  set_title: setTitleSchema,
  set_description: setDescriptionSchema,
  propose_item_texts: proposeItemTextsSchema,
  propose_item_panel: proposeItemPanelSchema,
} as const;

export type CommandName = keyof typeof commandSchemas;
export type CommandPayload<N extends CommandName> = z.infer<(typeof commandSchemas)[N]>;

/**
 * The commands Cockpit sends itself rather than taking from a client, and so
 * the ones with no endpoint and no sender (architecture.md §4.4, "two commands
 * carry no client and no route").
 */
export type SelfSentCommandName = 'propose_item_texts' | 'propose_item_panel';

/** The commands a client sends, which is every command with an endpoint. */
export type ClientCommandName = Exclude<CommandName, SelfSentCommandName>;

/**
 * What every command endpoint returns. `applied: false` = idempotent replay.
 *
 * `settledRouting` is `true` only for `move_item_to_panel`/`add_item_to_panel`,
 * and only where the write landed an Item on a real Panel for the first time
 * - the same fact `command-service.ts` computes once, atomically, to decide
 * whether to write `decisionHistory` ("Learn where notes belong from where
 * you actually file them", issue 299), surfaced here so a caller that needs
 * to know can read it off this one call rather than asking again, separately
 * and racily, before it ("Re-propose the rest of the inbox the moment you
 * file one", issue 300). Absent, not `false`, everywhere else - every other
 * command answers `applied` alone, exactly as before this existed.
 */
export const commandResultSchema = z.object({
  ok: z.literal(true),
  applied: z.boolean(),
  settledRouting: z.boolean().optional(),
});
export type CommandResult = z.infer<typeof commandResultSchema>;
