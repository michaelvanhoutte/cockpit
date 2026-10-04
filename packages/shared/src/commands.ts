import { z } from 'zod';
import {
  attachmentContentTypeSchema,
  attachmentFilenameSchema,
  MAX_ATTACHMENT_SIZE,
} from './domain/attachment.js';
import {
  associationKindSchema,
  capturedFromSchema,
  dashboardNameSchema,
  itemDescriptionSchema,
  itemReadingSchema,
  itemTitleSchema,
  prioritySchema,
  workspaceNameSchema,
} from './domain/item.js';
import {
  agentColorSchema,
  agentMessageSchema,
  agentNameSchema,
  agentEngineSchema,
} from './domain/agent.js';
import { itemFormPresentationSchema } from './domain/item-form-presentation.js';
import { itemTypeColorSchema, itemTypeNameSchema } from './domain/item-type.js';
import {
  filterConditionSchema,
  filterMatchSchema,
  panelSortSchema,
  panelFormatSchema,
  panelKindSchema,
  panelNameSchema,
  panelTextSchema,
  rowInputSchema,
} from './domain/panel.js';
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

/**
 * reorder_dashboards — the whole order of one workspace's dashboards, not the
 * move that produced it (architecture, "A whole order, never a relative move").
 *
 * The envelope's `workspaceId` is the scope rather than decoration: a dashboard
 * order belongs to one workspace, so the same id may sit in two orders that
 * know nothing about each other.
 */
export const reorderDashboardsSchema = commandEnvelopeSchema
  .extend({
    dashboardId: z.string().min(1),
    dashboardIds: z.array(z.string().min(1)).min(1),
  })
  .refine((cmd) => new Set(cmd.dashboardIds).size === cmd.dashboardIds.length, {
    message: 'a dashboard can only be in one place in the order',
    path: ['dashboardIds'],
  })
  .refine((cmd) => cmd.dashboardIds.includes(cmd.dashboardId), {
    message: 'the dashboard that moved is not in the order',
    path: ['dashboardIds'],
  });
export type ReorderDashboardsCommand = z.infer<typeof reorderDashboardsSchema>;

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
    /**
     * Whether an Item has to meet all of the conditions or any one ("Let a Filter
     * show items that meet any of its conditions", issue 504). Left out means
     * `all`, so a stale tab or a queued change from before this existed puts the
     * Filter back to what it always meant, the later whole save standing.
     */
    match: filterMatchSchema.default('all'),
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
 * set_panel_sort — how a Panel of items draws its rows, whole, or null for
 * Manual ("Sort a panel of items by the fields you choose", issue 526).
 *
 * Whole for the reason `set_panel_filter` is. Null rather than an empty list is
 * Manual, which `panelSortSchema` refuses, so there is one way to say it. The
 * filings are never touched, so going back to Manual gives back the order you
 * set.
 */
export const setPanelSortSchema = commandEnvelopeSchema.extend({
  panelId: z.uuid(),
  sort: panelSortSchema.nullable(),
});
export type SetPanelSortCommand = z.infer<typeof setPanelSortSchema>;

/**
 * save_layout — a dashboard's one arrangement, whole (architecture.md,
 * "`packages/shared`: schema and command rationale"). `layoutId` is the
 * dashboard's Layout, or a fresh client-generated id where it has none yet; a
 * save naming any other id still arranges the dashboard's own, unless that id
 * is another dashboard's Layout, which is refused as not found.
 * A tab from before Screen sizes were retired still sends `screenWidth` and
 * `screenSizeId`, which are dropped unread.
 */
export const saveLayoutSchema = commandEnvelopeSchema.extend({
  dashboardId: z.string(),
  layoutId: z.uuid(),
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
  /**
   * Where this came from, for a front door that carried it in from somewhere
   * else ("Save a Teams message to Cockpit", issue 486). Absent is a capture
   * made inside Cockpit, which is every front door that existed before it.
   *
   * **Written by an ingress route, and dropped from anything a client posts**
   * (`apps/api/src/http/app.ts`): what it says is read off a push the host has
   * already proved genuine, so a browser sending its own would be a browser
   * writing somebody else's name and link onto an Item of its own.
   */
  capturedFrom: capturedFromSchema.optional(),
  /**
   * A title the front door already has, taken as the Item's title with the
   * whole message as its description - a mail's subject beside its text
   * ("Bring in the conversations already labelled Cockpit as tasks", issue
   * 725). Left out, the title is cut from the message as it always was
   * (`textsFromCapture`).
   */
  title: itemTitleSchema.min(1).optional(),
  /**
   * What the Capture form's strip chose ("Set a priority and a due date while
   * capturing", issue 611): the same two values `set_priority` and
   * `set_due_date` change later. Left out by every other front door, which then
   * capture with neither, exactly as before.
   */
  priority: prioritySchema.optional(),
  dueDate: z.iso.date().optional(),
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

/** create_agent — made from the dock's own "+ New agent" ("Keep your agents in a dock, and choose which each dashboard shows", issue 570). */
export const createAgentSchema = commandEnvelopeSchema.extend({
  agentId: z.uuid(),
  name: agentNameSchema,
  color: agentColorSchema,
  engine: agentEngineSchema,
  message: agentMessageSchema,
  asksForPrompt: z.boolean(),
  startsInProgress: z.boolean(),
});
export type CreateAgentCommand = z.infer<typeof createAgentSchema>;

/**
 * update_agent — every field the dock's own form edits, sent together: unlike
 * a Type's name and colour, which are two separate concerns with their own
 * collision rule, an Agent's fields are all on one form with one Save.
 */
export const updateAgentSchema = commandEnvelopeSchema.extend({
  agentId: z.string().min(1),
  name: agentNameSchema,
  color: agentColorSchema,
  message: agentMessageSchema,
  asksForPrompt: z.boolean(),
  startsInProgress: z.boolean(),
});
export type UpdateAgentCommand = z.infer<typeof updateAgentSchema>;

/** delete_agent — gone from the dock and every dashboard's hidden list with it. */
export const deleteAgentSchema = commandEnvelopeSchema.extend({
  agentId: z.string().min(1),
});
export type DeleteAgentCommand = z.infer<typeof deleteAgentSchema>;

/**
 * hide_agent_on_dashboard — this Dashboard only ("Hiding and showing are per
 * dashboard", issue 570). The envelope's `workspaceId` is this Dashboard's
 * own Workspace, the same way a Panel or a Layout command's is.
 */
export const hideAgentOnDashboardSchema = commandEnvelopeSchema.extend({
  agentId: z.string().min(1),
  dashboardId: z.string().min(1),
});
export type HideAgentOnDashboardCommand = z.infer<typeof hideAgentOnDashboardSchema>;

/** show_agent_on_dashboard — undoes one hide_agent_on_dashboard. */
export const showAgentOnDashboardSchema = commandEnvelopeSchema.extend({
  agentId: z.string().min(1),
  dashboardId: z.string().min(1),
});
export type ShowAgentOnDashboardCommand = z.infer<typeof showAgentOnDashboardSchema>;

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

/** set_started — a flag rather than a pair of commands each way, the same choice `set_done` and `set_dismissed` make ("Mark an item In progress, and see since when", issue 568). */
export const setStartedSchema = commandEnvelopeSchema.extend({
  itemId: z.uuid(),
  started: z.boolean(),
});
export type SetStartedCommand = z.infer<typeof setStartedSchema>;

/**
 * begin_agent_run — a run recorded as starting, before Claude is called
 * ("Drop an agent on an item to start a Claude Code session on it", issue
 * 571). Sent by the start route alone, never posted as JSON: the call to
 * Claude that follows it is what the route exists for (see
 * `startAgentSchema`).
 */
export const beginAgentRunSchema = commandEnvelopeSchema.extend({
  runId: z.uuid(),
  itemId: z.uuid(),
  agentId: z.string().min(1),
  dashboardId: z.string().min(1),
});
export type BeginAgentRunCommand = z.infer<typeof beginAgentRunSchema>;

/**
 * settle_agent_run — how Claude answered a run's start (issue 571). Sent by
 * the start route once Claude has answered or failed to, never by a client.
 *
 * `connectionFailing` is the refusal's reason where Claude refused the
 * connection itself, which the dock and the connection's own row then say
 * until a start works; a refusal that says nothing about the connection - a
 * fault at Claude's end - leaves it untouched.
 */
export const settleAgentRunSchema = commandEnvelopeSchema.extend({
  runId: z.uuid(),
  itemId: z.uuid(),
  status: z.enum(['working', 'link_lost', 'unknown', 'failed']),
  sessionUrl: z.url({ protocol: /^https?$/ }).max(2048).optional(),
  reason: z.string().max(500).optional(),
  connectionFailing: z.boolean().optional(),
});
export type SettleAgentRunCommand = z.infer<typeof settleAgentRunSchema>;

/**
 * finish_agent_run — "Agent finished: Done" or "Agent finished: Still to do"
 * (issue 571). Ends the run, and settles the Item the way marking it done or
 * putting it back to To do would.
 */
export const finishAgentRunSchema = commandEnvelopeSchema.extend({
  runId: z.uuid(),
  itemId: z.uuid(),
  outcome: z.enum(['done', 'still_to_do']),
});
export type FinishAgentRunCommand = z.infer<typeof finishAgentRunSchema>;

/**
 * report_agent_run_activity — a Claude Code hook saying its session stopped
 * for you (`waiting`) or took a prompt again ("See on the item when Claude is
 * waiting on you", issue 572). Sent by the hook route alone, once the call's
 * secret has been checked; moves the Workspace's open run whose session one
 * of `sessionIds` names, and nothing where none does.
 */
export const reportAgentRunActivitySchema = commandEnvelopeSchema.extend({
  sessionIds: z.array(z.string().min(1).max(200)).min(1).max(2),
  waiting: z.boolean(),
});
export type ReportAgentRunActivityCommand = z.infer<typeof reportAgentRunActivitySchema>;

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

/** set_item_type - the type an item is, changed after capture; never "none", which capture does not offer either ("Change an item's type, and its status, from its form, and see where it is shown", issue 528). */
export const setItemTypeSchema = commandEnvelopeSchema.extend({
  itemId: z.uuid(),
  typeId: z.string().min(1),
});
export type SetItemTypeCommand = z.infer<typeof setItemTypeSchema>;

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
 * set_item_form_presentation — whether the account has the Item's form drawn
 * centered or docked to the side ("Let the item's form dock to the side of the
 * screen instead of opening as a dialog", issue 481). Account-scoped:
 * `workspaceId` on the envelope is `ACCOUNT_WIDE`.
 */
export const setItemFormPresentationSchema = commandEnvelopeSchema.extend({
  presentation: itemFormPresentationSchema,
});
export type SetItemFormPresentationCommand = z.infer<typeof setItemFormPresentationSchema>;
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
 * connect_source_account — a Workspace's Teams or Gmail sign-in, once the
 * source has said who it was and the credential has been sealed ("Connect a
 * Microsoft Teams source account", issue 485; "Connect a Gmail account to a
 * workspace, and disconnect it", issue 724).
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
 * tombstone: what makes disconnecting mean anything is that the credential
 * stops existing.
 */
export const disconnectSourceAccountSchema = commandEnvelopeSchema.extend({
  sourceAccountId: z.string().min(1),
});
export type DisconnectSourceAccountCommand = z.infer<typeof disconnectSourceAccountSchema>;

/**
 * mark_source_account_tested - a connection proven to still work without
 * changing what it holds ("Connect a workspace to Claude Code", issue 569,
 * "Test again"). Written by the test route once Claude has actually accepted
 * a session, never posted as JSON by a client: the credential that call was
 * made with is never handed back to the browser to prove first (rule 3,
 * "the token never leaves the server once stored").
 */
export const markSourceAccountTestedSchema = commandEnvelopeSchema.extend({
  sourceAccountId: z.string().min(1),
});
export type MarkSourceAccountTestedCommand = z.infer<typeof markSourceAccountTestedSchema>;

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
  reorder_dashboards: reorderDashboardsSchema,
  add_panel: addPanelSchema,
  rename_panel: renamePanelSchema,
  delete_panel: deletePanelSchema,
  move_panel_to_dashboard: movePanelToDashboardSchema,
  set_panel_text: setPanelTextSchema,
  set_panel_read_only: setPanelReadOnlySchema,
  set_panel_format: setPanelFormatSchema,
  set_panel_filter: setPanelFilterSchema,
  set_panel_sort: setPanelSortSchema,
  save_layout: saveLayoutSchema,
  capture_item: captureItemSchema,
  create_item_type: createItemTypeSchema,
  rename_item_type: renameItemTypeSchema,
  set_item_type_color: setItemTypeColorSchema,
  delete_item_type: deleteItemTypeSchema,
  reorder_item_types: reorderItemTypesSchema,
  create_agent: createAgentSchema,
  update_agent: updateAgentSchema,
  delete_agent: deleteAgentSchema,
  hide_agent_on_dashboard: hideAgentOnDashboardSchema,
  show_agent_on_dashboard: showAgentOnDashboardSchema,
  move_item_to_panel: moveItemToPanelSchema,
  add_item_to_panel: addItemToPanelSchema,
  remove_item_from_panel: removeItemFromPanelSchema,
  set_done: setDoneSchema,
  set_started: setStartedSchema,
  begin_agent_run: beginAgentRunSchema,
  settle_agent_run: settleAgentRunSchema,
  finish_agent_run: finishAgentRunSchema,
  report_agent_run_activity: reportAgentRunActivitySchema,
  set_dismissed: setDismissedSchema,
  associate: associateSchema,
  set_next_action: setNextActionSchema,
  set_priority: setPrioritySchema,
  set_item_type: setItemTypeSchema,
  set_due_date: setDueDateSchema,
  set_title: setTitleSchema,
  set_description: setDescriptionSchema,
  add_attachment: addAttachmentSchema,
  remove_attachment: removeAttachmentSchema,
  set_item_form_presentation: setItemFormPresentationSchema,
  propose_item_texts: proposeItemTextsSchema,
  propose_item_panel: proposeItemPanelSchema,
  connect_source_account: connectSourceAccountSchema,
  disconnect_source_account: disconnectSourceAccountSchema,
  mark_source_account_tested: markSourceAccountTestedSchema,
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
  | 'connect_source_account'
  // Sent by the Claude Code connect/test routes once Claude has actually
  // answered, never posted as JSON directly (see `markSourceAccountTestedSchema`
  // above).
  | 'mark_source_account_tested'
  // Sent by the route that starts an agent, around its one call to Claude
  // (see `beginAgentRunSchema` above).
  | 'begin_agent_run'
  | 'settle_agent_run'
  // Sent by the Claude Code hook route once the call's secret is checked (see
  // `reportAgentRunActivitySchema` above).
  | 'report_agent_run_activity';

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
