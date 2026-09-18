import { z } from 'zod';
import {
  attachmentContentTypeSchema,
  attachmentFilenameSchema,
  MAX_ATTACHMENT_SIZE,
} from './domain/attachment.js';
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
  filterConditionSchema,
  panelFormatSchema,
  panelKindSchema,
  panelNameSchema,
  panelTextSchema,
  rowInputSchema,
} from './domain/panel.js';
import {
  pinnedExampleDescriptionSchema,
  pinnedExampleNoteSchema,
  pinnedExampleTitleSchema,
} from './domain/pinned-text-examples.js';
import { routingSummaryCorrectionSchema } from './domain/routing-summary.js';
import { textLearningRulesSchema } from './domain/text-learning-rules.js';
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

/**
 * move_panel_to_dashboard — a Panel taken off the dashboard it was made on and
 * given to another of the same workspace, placement and all ("Move a panel to
 * another dashboard, from its menu or by dragging it onto a tab", issue 439;
 * architecture.md §4.4).
 *
 * `dashboardId` names the *target* - the source is the panel's own, read off
 * the row rather than sent, so a stale client cannot move a panel from
 * somewhere it no longer is.
 */
export const movePanelToDashboardSchema = commandEnvelopeSchema.extend({
  panelId: z.uuid(),
  dashboardId: z.string(),
});
export type MovePanelToDashboardCommand = z.infer<typeof movePanelToDashboardSchema>;

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
 * set_panel_filter — what a Filter shows, whole ("Add a Filter panel that shows
 * every filed item due in a window", issue 463).
 *
 * The whole list rather than the row that changed, for the reason
 * `set_panel_text` carries a whole document: the question is saved at once, and
 * two people editing it is the later save standing rather than a merge nobody
 * asked for. An empty list is a real answer — the Filter goes back to saying it
 * has nothing chosen.
 *
 * **Capped**, as `panelTextSchema` caps the other free-form thing a Panel
 * stores: this list is written into a column every snapshot of the Workspace
 * then carries to every device on it, and nothing downstream bounds it the way
 * an `order` is bounded by the Items it names. Far past any question built a
 * row at a time.
 */
export const CONDITIONS_LIMIT = 50;
export const setPanelFilterSchema = commandEnvelopeSchema
  .extend({
    panelId: z.uuid(),
    conditions: z.array(filterConditionSchema).max(CONDITIONS_LIMIT),
  })
  // A field already on the Filter is not offered a second time in the
  // question ("Filter a Filter panel by priority and type", issue 464); this
  // is that same rule refused server-side too, so a stale client cannot send
  // what its own menu would no longer offer it.
  .refine(
    (cmd) => {
      const fields = cmd.conditions.map((condition) => condition.field);
      return new Set(fields).size === fields.length;
    },
    { message: 'a field appears once on a Filter', path: ['conditions'] },
  );
export type SetPanelFilterCommand = z.infer<typeof setPanelFilterSchema>;

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

export const setDueDateSchema = commandEnvelopeSchema.extend({
  itemId: z.uuid(),
  dueDate: z.iso.date().nullable(),
});
export type SetDueDateCommand = z.infer<typeof setDueDateSchema>;

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
 * add_attachment ("Attach a file to an item", issue 441). **Written by the
 * upload route after a file's bytes have already streamed to R2, never
 * posted as JSON by a client itself** (`apps/api/src/http/app.ts`, the
 * attachments upload route) - there is no way to carry a file's bytes in a
 * JSON command payload, so this is the one command a browser triggers
 * without ever sending this shape over the wire. `size`/`contentType` are
 * what the upload route itself measured and validated, never what the
 * browser merely claimed.
 */
export const addAttachmentSchema = commandEnvelopeSchema.extend({
  attachmentId: z.uuid(),
  itemId: z.uuid(),
  filename: attachmentFilenameSchema,
  size: z.number().int().positive().max(MAX_ATTACHMENT_SIZE),
  contentType: attachmentContentTypeSchema,
});
export type AddAttachmentCommand = z.infer<typeof addAttachmentSchema>;

/**
 * remove_attachment - the reference only; the file itself is left in R2
 * (issue 441, "tombstone-not-delete stance", chosen specifically so this
 * build has no state it can destroy).
 */
export const removeAttachmentSchema = commandEnvelopeSchema.extend({
  attachmentId: z.uuid(),
  itemId: z.uuid(),
});
export type RemoveAttachmentCommand = z.infer<typeof removeAttachmentSchema>;

/**
 * set_routing_summary_correction — what one Workspace's own sentence about
 * where its notes belong says, in the writer's words ("Show what the system
 * learned, in a sentence you can correct", issue 301). It corrected a
 * generated summary once; that summary is gone and this outlived it ("Drop
 * the nightly filing summary, keep the sentence you wrote", issue 392), so it
 * is now the only text on this table anything reads. The empty string clears
 * it, the same idiom `set_description`'s `null` uses for "nothing here" —
 * empty rather than null because this field has no third state to spend null
 * on (`domain/routing-summary.ts`).
 */
export const setRoutingSummaryCorrectionSchema = commandEnvelopeSchema.extend({
  correction: routingSummaryCorrectionSchema,
});
export type SetRoutingSummaryCorrectionCommand = z.infer<typeof setRoutingSummaryCorrectionSchema>;

/**
 * set_text_learning_rules — the account's own rules for how Cockpit writes a
 * title and a message, in the writer's own words ("Show what Cockpit is
 * told, and say how you want it changed", issue 398). Account-scoped, unlike
 * `set_routing_summary_correction` above — `workspaceId` on the envelope is
 * `ACCOUNT_WIDE`, the same convention `create_item_type` and its siblings
 * use. The empty string clears it, the same idiom `set_routing_summary_correction`
 * uses for the same reason (`domain/text-learning-rules.ts`).
 */
export const setTextLearningRulesSchema = commandEnvelopeSchema.extend({
  rules: textLearningRulesSchema,
});
export type SetTextLearningRulesCommand = z.infer<typeof setTextLearningRulesSchema>;

/**
 * pin_text_example — a worked example of a note and the title and message
 * chosen for it, added by hand rather than corrected after the fact ("Pin an
 * example of how you want a note written", issue 397). Account-scoped, the
 * same convention `set_text_learning_rules` above uses.
 *
 * **One command for all three fields**, the same shape `set_workspace_theme`
 * takes for its four colours: a note, its title and its message are one
 * example rather than three independently-settleable facts, unlike an
 * Item's title and description, which stay two commands because either can
 * be corrected on its own, days apart.
 */
export const pinTextExampleSchema = commandEnvelopeSchema.extend({
  exampleId: z.uuid(),
  note: pinnedExampleNoteSchema,
  title: pinnedExampleTitleSchema,
  description: pinnedExampleDescriptionSchema,
});
export type PinTextExampleCommand = z.infer<typeof pinTextExampleSchema>;

/** edit_pinned_example — replaces all three fields of an example already pinned. */
export const editPinnedExampleSchema = commandEnvelopeSchema.extend({
  exampleId: z.string().min(1),
  note: pinnedExampleNoteSchema,
  title: pinnedExampleTitleSchema,
  description: pinnedExampleDescriptionSchema,
});
export type EditPinnedExampleCommand = z.infer<typeof editPinnedExampleSchema>;

/** delete_pinned_example — gone for good, the same as deleting a correction ("See what it got right, and what you corrected", issue 412): nothing else references a pinned example, so there is no tombstone to keep a foreign key satisfied. */
export const deletePinnedExampleSchema = commandEnvelopeSchema.extend({
  exampleId: z.string().min(1),
});
export type DeletePinnedExampleCommand = z.infer<typeof deletePinnedExampleSchema>;

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
 *
 * `panelId: null` withdraws an earlier proposal rather than naming a new one
 * - a routing may be replaced by the system at any time
 * (`docs/routing-learning.md`, "The rule"), and a settled filing's refresh of
 * the rest of its Workspace's Inbox ("Re-propose the rest of the inbox the
 * moment you file one", issue 300) can conclude that a Panel it once
 * proposed no longer fits, which is a replacement with nothing rather than
 * with something else. `reason` is empty exactly when `panelId` is, the same
 * idiom the AI layer's own schema uses for "none".
 */
export const proposeItemPanelSchema = commandEnvelopeSchema
  .extend({
    itemId: z.uuid(),
    panelId: z.uuid().nullable(),
    reason: z.string().trim(),
  })
  .refine((cmd) => (cmd.panelId === null ? cmd.reason === '' : cmd.reason.length > 0), {
    message: 'a reason is required when naming a Panel, and empty when withdrawing the proposal',
    path: ['reason'],
  });
export type ProposeItemPanelCommand = z.infer<typeof proposeItemPanelSchema>;

/**
 * connect_source_account — a Workspace's Teams sign-in, once Microsoft has
 * said who it was and the credential has been sealed ("Connect a Microsoft
 * Teams source account", issue 485).
 *
 * **Written by the callback route, never posted as JSON by a client** - the
 * same standing `add_attachment` above has, and for a sharper reason: the
 * payload carries a sealed credential, so a route a browser could post to
 * would be a route a browser could put its own credential through.
 *
 * `externalAccountKey` is what makes connecting the same account twice a
 * refresh rather than a second row, and it is derived from the identity
 * Microsoft returned rather than sent by anybody
 * (`apps/api/src/connectors/teams.ts`).
 */
export const connectSourceAccountSchema = commandEnvelopeSchema.extend({
  sourceAccountId: z.uuid(),
  connectorId: z.string().min(1),
  externalAccountKey: z.string().min(1),
  displayName: z.string().min(1),
  /** The credential as it is stored: sealed bytes, and the nonce they were sealed under. */
  sealedCredential: z.string().min(1),
  credentialNonce: z.string().min(1),
});
export type ConnectSourceAccountCommand = z.infer<typeof connectSourceAccountSchema>;

/**
 * disconnect_source_account - the row and the credential sealed in it, gone
 * for good ("Connect a Microsoft Teams source account", issue 485). No
 * tombstone, for the reason `delete_pinned_example` has none and one of its
 * own: what makes disconnecting mean anything is that the credential stops
 * existing.
 */
export const disconnectSourceAccountSchema = commandEnvelopeSchema.extend({
  sourceAccountId: z.string().min(1),
});
export type DisconnectSourceAccountCommand = z.infer<typeof disconnectSourceAccountSchema>;

/**
 * set_duplicate_settled — a flagged pair settled as not a duplicate, or that
 * settling taken back ("Say a flagged pair is not a duplicate", issue 408;
 * `docs/routing-learning.md`, "Cockpit may replace what it proposed and never
 * what you settled" - the same rule, applied here to a pair instead of a
 * filing).
 *
 * The two ids in whichever order they are sent - the pair is unordered, the
 * same way `PossibleDuplicate` itself is (`domain/duplicate.ts`) - and a flag
 * rather than a pair of commands each way, the same choice `set_dismissed`
 * makes: undoing is sending this again with `settled: false`.
 */
export const setDuplicateSettledSchema = commandEnvelopeSchema
  .extend({
    itemId: z.uuid(),
    otherItemId: z.uuid(),
    settled: z.boolean(),
  })
  .refine((cmd) => cmd.itemId !== cmd.otherItemId, {
    message: 'a pair needs two different items',
    path: ['otherItemId'],
  });
export type SetDuplicateSettledCommand = z.infer<typeof setDuplicateSettledSchema>;

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
  move_panel_to_dashboard: movePanelToDashboardSchema,
  set_panel_text: setPanelTextSchema,
  set_panel_read_only: setPanelReadOnlySchema,
  set_panel_format: setPanelFormatSchema,
  set_panel_filter: setPanelFilterSchema,
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
  set_due_date: setDueDateSchema,
  set_title: setTitleSchema,
  set_description: setDescriptionSchema,
  add_attachment: addAttachmentSchema,
  remove_attachment: removeAttachmentSchema,
  set_routing_summary_correction: setRoutingSummaryCorrectionSchema,
  set_text_learning_rules: setTextLearningRulesSchema,
  pin_text_example: pinTextExampleSchema,
  edit_pinned_example: editPinnedExampleSchema,
  delete_pinned_example: deletePinnedExampleSchema,
  propose_item_texts: proposeItemTextsSchema,
  propose_item_panel: proposeItemPanelSchema,
  connect_source_account: connectSourceAccountSchema,
  disconnect_source_account: disconnectSourceAccountSchema,
  set_duplicate_settled: setDuplicateSettledSchema,
} as const;

export type CommandName = keyof typeof commandSchemas;
export type CommandPayload<N extends CommandName> = z.infer<(typeof commandSchemas)[N]>;

/**
 * The commands Cockpit sends itself rather than taking from a client, and so
 * the ones with no endpoint and no sender (architecture.md §4.4, "two commands
 * carry no client and no route").
 */
export type SelfSentCommandName =
  | 'propose_item_texts'
  | 'propose_item_panel'
  // Sent by the callback Microsoft returns to, which is a navigation rather
  // than a request a page makes - and which carries a sealed credential no
  // browser may ever hand over (see `connectSourceAccountSchema` above).
  | 'connect_source_account';

/**
 * The commands a client sends, which is every command with a generic JSON
 * endpoint. `add_attachment` is excluded alongside the self-sent commands
 * above for a different reason: a client does trigger it, but never by
 * posting this payload as JSON - the upload route builds it itself once a
 * file's bytes have already streamed to R2 (see `addAttachmentSchema`
 * above).
 */
export type ClientCommandName = Exclude<CommandName, SelfSentCommandName | 'add_attachment'>;

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
 * file one", issue 300).
 *
 * `recordedCorrection` is `true` only for `set_title`/`set_description`, and
 * only where the write recorded or updated a `text_corrections` row - the
 * same fact `command-service.ts` computes once, atomically, to decide whether
 * to write that row, surfaced here for the same reason and by the same
 * pattern as `settledRouting` above ("Re-read the rest of the inbox the
 * moment you fix a title", issue 399).
 *
 * Both absent, not `false`, everywhere else - every other command answers
 * `applied` alone, exactly as before either existed.
 */
export const commandResultSchema = z.object({
  ok: z.literal(true),
  applied: z.boolean(),
  settledRouting: z.boolean().optional(),
  recordedCorrection: z.boolean().optional(),
});
export type CommandResult = z.infer<typeof commandResultSchema>;
