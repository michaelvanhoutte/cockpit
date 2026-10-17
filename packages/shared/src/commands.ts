import { z } from 'zod';
import {
  attachmentContentTypeSchema,
  attachmentFilenameSchema,
  MAX_ATTACHMENT_SIZE,
} from './domain/attachment.js';
import {
  associationKindSchema,
  capturedFromSchema,
  captureTimeZoneSchema,
  dashboardNameSchema,
  itemDescriptionSchema,
  itemReadingSchema,
  itemTitleSchema,
  panelFitSchema,
  prioritySchema,
  workspaceNameSchema,
} from './domain/item.js';
import {
  REMEMBERED_ACTION_LIMIT,
  REMEMBERED_SENTENCE_LIMIT,
  REMEMBERED_SENTENCES_SHOWN,
} from './domain/remembered-sentence.js';
import {
  CLAUDE_PROMPT_LIMIT,
  CLAUDE_REPORTED_STAGES,
  REPORT_NOTE_LIMIT,
  claudeDestinationSchema,
  claudeFolderSchema,
  claudeResultLink,
  claudeSessionLink,
} from './domain/claude-send.js';
import { claudeProposalsSchema } from './domain/claude-proposal.js';
import { itemFormPresentationSchema } from './domain/item-form-presentation.js';
import {
  filterConditionSchema,
  filterGroupingSchema,
  panelSortSchema,
  panelFormatSchema,
  panelKindSchema,
  panelNameSchema,
  panelTextSchema,
  rowInputSchema,
} from './domain/panel.js';
import { hexColorSchema } from './domain/workspace-themes.js';

/** What a change to the whole account names instead of a workspace: remembered sentences, the Item form's presentation. */
export const ACCOUNT_WIDE = 'account';

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

/**
 * set_panel_settings — what the Panel settings form changed, all of it or none
 * ("Change a Panel's name and settings in one Panel settings form", issue 1206).
 *
 * Only the fields the form changed travel, so a second tab's change to a field
 * this form never touched is not written over. The single-setting commands stay
 * beside it for a tab still on the previous release.
 */
export const setPanelSettingsSchema = commandEnvelopeSchema
  .extend({
    panelId: z.uuid(),
    name: panelNameSchema.optional(),
    /** A Panel of items only. */
    neverPropose: z.boolean().optional(),
    /** A Panel of text only. */
    readOnly: z.boolean().optional(),
    /** A Panel of text only. */
    format: panelFormatSchema.optional(),
  })
  .refine(
    (cmd) =>
      cmd.name !== undefined ||
      cmd.neverPropose !== undefined ||
      cmd.readOnly !== undefined ||
      cmd.format !== undefined,
    { message: 'a save with nothing changed is not a command', path: ['name'] },
  );
export type SetPanelSettingsCommand = z.infer<typeof setPanelSettingsSchema>;

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

/** set_panel_never_propose — whether a Panel of items is kept out of routing proposals ("Keep a Panel out of proposals with Never propose", issue 848). */
export const setPanelNeverProposeSchema = commandEnvelopeSchema.extend({
  panelId: z.uuid(),
  neverPropose: z.boolean(),
});
export type SetPanelNeverProposeCommand = z.infer<typeof setPanelNeverProposeSchema>;

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
 * The whole Filter rather than the row that changed, for the reason
 * `set_panel_text` carries a whole document: the question is saved at once, and
 * two people editing it is the later save standing rather than a merge nobody
 * asked for. No rows is a real answer — the Filter goes back to saying it has
 * nothing chosen.
 *
 * **Rows only** ("Store every Filter as rows, and save the All / Any choice as
 * rows", issue 1081): an Item meets every row, and meets a row by meeting any
 * one of its conditions. The flat `conditions` and `match` a tab on the
 * previous release sends is refused, since that tab reads a Filter stored in
 * rows as nothing chosen, and its save would overwrite the real one with that.
 *
 * **Capped across rows**, as `panelTextSchema` caps the other free-form thing a
 * Panel stores: this is written into a column every snapshot of the Workspace
 * then carries to every device on it, and nothing downstream bounds it the way
 * an `order` is bounded by the Items it names. Far past any question built a
 * condition at a time.
 */
export const CONDITIONS_LIMIT = 50;
export const setPanelFilterSchema = commandEnvelopeSchema
  .extend({
    panelId: z.uuid(),
    // An empty row would be met by every Item or none depending on how it was
    // read, so it is refused rather than given a meaning.
    rows: z.array(z.array(filterConditionSchema).min(1)).max(CONDITIONS_LIMIT),
    /**
     * What the Filter's Items are grouped under ("Group a Filter panel's items
     * by the Dashboard or Panel they are filed on", issue 805). Left out means
     * `none`. A grouping the contract does not name is refused rather than
     * defaulted: a save is the one place a value is chosen, so reading it back
     * as something else would hide the bug.
     */
    groupBy: filterGroupingSchema.default('none'),
  })
  .refine((cmd) => cmd.rows.reduce((total, row) => total + row.length, 0) <= CONDITIONS_LIMIT, {
    message: `a Filter holds at most ${CONDITIONS_LIMIT} conditions`,
    path: ['rows'],
  })
  // A field already in a row is not offered a second time in it ("Filter a
  // Filter panel by priority and type", issue 464); this is that same rule
  // refused server-side too, so a stale client cannot send what its own menu
  // would no longer offer it. The same field in two rows is a real question.
  .refine(
    (cmd) =>
      cmd.rows.every((row) => new Set(row.map((condition) => condition.field)).size === row.length),
    { message: 'a field appears once in a row of a Filter', path: ['rows'] },
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
  /**
   * Sent by every client that knows Sections, so a save with none in `rows`
   * deletes them. A save without it is from a tab that predates them, and keeps
   * the stored Sections where they were ("Add, rename and delete a titled
   * Section on a Dashboard", issue 896).
   */
  carriesSections: z.literal(true).optional(),
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
  /**
   * The Panels Capture's *File on* chose ("File a note on Panels from Capture,
   * skipping the Inbox", issue 1101): the Item is made and filed on each in the
   * one transaction, at the top. **Never a reason to refuse** - a Panel that is
   * gone, is of another Workspace or takes no Items is skipped, and with none
   * left the Item lands in the Inbox. Left out by every other front door, and by
   * an outbox entry kept before it.
   */
  panelIds: z.array(z.uuid()).max(50).optional(),
  /**
   * The device's time zone, read the moment Capture is pressed - not when the
   * capture is sent, so a note kept offline is read on the calendar it was
   * captured on ("Read a due date you say when you capture, on your own
   * calendar", issue 1077). Sent by every front door a person captures through
   * in the app; left out by the others, and by an outbox entry kept before it.
   */
  timeZone: captureTimeZoneSchema.optional(),
  /**
   * Never given: a capture carries no Type ("Capture without a Type, at every
   * front door", issue 1067). Named only so a client still sending one is
   * refused - an unknown key is dropped, which would accept it in silence.
   */
  typeId: z.never({ error: 'a capture is not given a type' }).optional(),
});
export type CaptureItemCommand = z.infer<typeof captureItemSchema>;

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
    /**
     * The Panels the move takes the Item off ("Move an Item from one Panel's row
     * without taking it off its other Panels", issue 923). Absent or empty takes it
     * off every Panel (to take it off none, `add_item_to_panel`),
     * which is what undo and a tab on the previous release send; a
     * move to the Inbox takes it off every Panel whatever is named.
     */
    fromPanelIds: z.array(z.uuid()).optional(),
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
  /** An undo's way of naming the run the Done it undoes ended, so the server reopens exactly that one. */
  reopensRunId: z.uuid().optional(),
});
export type SetDoneCommand = z.infer<typeof setDoneSchema>;

export const setDismissedSchema = commandEnvelopeSchema.extend({
  itemId: z.uuid(),
  dismissed: z.boolean(),
  /** As on `set_done`: the run the Dismiss being undone ended. */
  reopensRunId: z.uuid().optional(),
});
export type SetDismissedCommand = z.infer<typeof setDismissedSchema>;

/** set_started — a flag rather than a pair of commands each way, the same choice `set_done` and `set_dismissed` make ("Mark an item In progress, and see since when", issue 568). */
export const setStartedSchema = commandEnvelopeSchema.extend({
  itemId: z.uuid(),
  started: z.boolean(),
});
export type SetStartedCommand = z.infer<typeof setStartedSchema>;

/**
 * send_item_to_claude — an Item sent to Cowork or Claude Code from its row,
 * recorded as a Run that is *Sent* just before the browser opens the
 * `claude://` address ("Send an item to Cowork or Claude Code with its prompt
 * reviewed first", issue 1159). `runId` is chosen by the browser, because the
 * prompt it is about to send already names it. **The Run does not keep the
 * prompt**; the send is kept apart, as an example for later proposals ("Learn
 * from what you sent to Claude", issue 1162), from `prompt` - what the window
 * sent - and `proposed` - what it opened on, which the Item's own proposal may
 * have moved on from by now. Both optional, so a tab from before them still
 * sends, and learns nothing; an edit made later inside Claude is not Cockpit's
 * to keep.
 */
export const sendItemToClaudeSchema = commandEnvelopeSchema.extend({
  runId: z.uuid(),
  itemId: z.uuid(),
  destination: claudeDestinationSchema,
  folder: claudeFolderSchema.default(''),
  prompt: z.string().max(CLAUDE_PROMPT_LIMIT).optional(),
  proposed: z
    .object({
      destination: claudeDestinationSchema,
      folder: claudeFolderSchema.default(''),
      prompt: z.string().max(CLAUDE_PROMPT_LIMIT),
    })
    .optional(),
});
export type SendItemToClaudeCommand = z.infer<typeof sendItemToClaudeSchema>;

/**
 * report_claude_run — Cowork or Claude Code saying how a Run it was sent
 * stands ("Follow on the row what Claude reports back", issue 1160). Sent by
 * the MCP tool alone, never posted as JSON: the Run's own Workspace is found
 * from the Run, so `workspaceId` here is not read. Only the stage, the two
 * links and the note change, and a link that is not safe to open is refused
 * (`claudeSessionLink`, `claudeResultLink`).
 */
export const reportClaudeRunSchema = commandEnvelopeSchema.extend({
  runId: z.uuid(),
  stage: z.enum(CLAUDE_REPORTED_STAGES),
  sessionUrl: z
    .string()
    .refine((value) => claudeSessionLink(value) !== null)
    .optional(),
  resultUrl: z
    .string()
    .refine((value) => claudeResultLink(value) !== null)
    .optional(),
  note: z.string().max(REPORT_NOTE_LIMIT).optional(),
});
export type ReportClaudeRunCommand = z.infer<typeof reportClaudeRunSchema>;

/**
 * finish_agent_run — "Agent finished: Done" or "Agent finished: Still to do"
 * (issue 571). Ends the run, and settles the Item the way marking it done or
 * putting it back to To do would. No longer sent by the app, whose Status ends
 * the run; the server still accepts it for tabs on the previous build and
 * queued offline commands.
 */
export const finishAgentRunSchema = commandEnvelopeSchema.extend({
  runId: z.uuid(),
  itemId: z.uuid(),
  outcome: z.enum(['done', 'still_to_do']),
});
export type FinishAgentRunCommand = z.infer<typeof finishAgentRunSchema>;

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
 *
 * `fit` says how sure the proposal is ("Propose the closest Panel at capture,
 * and draw a less certain one dashed", issue 1107), and is absent where the
 * call that proposed it was not asked - which is stored as nothing and read as
 * `clear` - and always absent on a withdrawal.
 */
export const proposeItemPanelSchema = commandEnvelopeSchema
  .extend({
    itemId: z.uuid(),
    panelId: z.uuid().nullable(),
    reason: z.string().trim(),
    fit: panelFitSchema.optional(),
  })
  .refine((cmd) => (cmd.panelId === null ? cmd.reason === '' : cmd.reason.length > 0), {
    message: 'a reason is required when naming a Panel, and empty when withdrawing the proposal',
    path: ['reason'],
  })
  .refine((cmd) => cmd.panelId !== null || cmd.fit === undefined, {
    message: 'a withdrawn proposal says nothing about how sure it is',
    path: ['fit'],
  });
export type ProposeItemPanelCommand = z.infer<typeof proposeItemPanelSchema>;

/**
 * propose_item_for_claude - what Cockpit proposes doing with an Item, sent by
 * the enrichment job ("Propose what to do with each item before you look",
 * issue 1161), replacing whatever the Item carried. `madeFrom` is the Item's
 * `updatedAt` as the job read it: an Item changed since is left alone, and the
 * job asks for its proposal again.
 */
export const proposeItemForClaudeSchema = commandEnvelopeSchema.extend({
  itemId: z.uuid(),
  proposals: claudeProposalsSchema,
  madeFrom: z.iso.datetime(),
  /** The remembered sentences this proposal was made with, each counted as used once the proposal is written (issue 1163). */
  usedSentenceIds: z.array(z.uuid()).max(REMEMBERED_SENTENCES_SHOWN).optional(),
});
export type ProposeItemForClaudeCommand = z.infer<typeof proposeItemForClaudeSchema>;
/** The most Panels one note is filed on; the job sends no more, so a long answer never fails the whole reading (issue 1116). */
export const PANELS_A_NOTE_FILES_ON = 20;

/**
 * propose_item_fields — the fields a captured note stated, read by the
 * enrichment job rather than sent by a client ("Read a priority you say when
 * you capture", issue 1076). Each field is absent where the note stated none,
 * and each is applied or refused on its own: one the person set, or one that
 * already holds a value, is left as it is. Priority and the due date ("Read a
 * due date you say when you capture, on your own calendar", issue 1077); and
 * the Workspace a note names, for an Item captured to Any workspace ("Settle
 * an Any workspace capture in the workspace you name", issue 1078).
 */
export const proposeItemFieldsSchema = commandEnvelopeSchema.extend({
  itemId: z.uuid(),
  priority: prioritySchema.optional(),
  /** A calendar day, never a time ("Read a due date you say when you capture, on your own calendar", issue 1077). */
  dueDate: z.iso.date().optional(),
  /**
   * The Workspace the note named, settled the way filing settles one: only for
   * an Item that belongs to none yet, and refused where the Workspace is gone
   * by the time this is written (issue 1078). The envelope's `workspaceId` is
   * still the Workspace the Item is in, which is not a decision. Not a uuid:
   * every account's first Workspace is `ws-1`.
   */
  settleInWorkspaceId: z.string().min(1).optional(),
  /**
   * The Panels the note named, filed on at the top of each as the person's own
   * filing, in the same act as the Workspace above ("File a capture on the
   * panels you name, read from the spoken path", issue 1116): only for an Item
   * nobody has filed, dismissed or finished with, and only on a Panel that is
   * live, takes items and is in the Item's Workspace when this is written.
   */
  fileOnPanelIds: z.array(z.string().min(1)).max(PANELS_A_NOTE_FILES_ON).optional(),
});
export type ProposeItemFieldsCommand = z.infer<typeof proposeItemFieldsSchema>;

/**
 * connect_source_account — a Workspace's sign-in to a source, once the
 * source has said who it was and the credential has been sealed ("Connect a
 * Microsoft Teams source account", issue 485; "Connect and disconnect a
 * source through one generic sign-in flow", issue 892).
 *
 * **Written by the callback route, never posted as JSON by a client** - the
 * same standing `add_attachment` above has, and for a sharper reason: the
 * payload carries a sealed credential, so a route a browser could post to
 * would be a route a browser could put its own credential through.
 *
 * `externalAccountKey` is what makes connecting the same account twice a
 * refresh rather than a second row, and it is derived from the identity
 * Microsoft returned rather than sent by anybody
 * (`packages/connectors/teams/src/sign-in.ts`).
 */
export const connectSourceAccountSchema = commandEnvelopeSchema.extend({
  sourceAccountId: z.uuid(),
  connectorId: z.string().min(1),
  externalAccountKey: z.string().min(1),
  displayName: z.string().min(1),
  /** The credential as it is stored: sealed bytes, and the nonce they were sealed under. */
  sealedCredential: z.string().min(1),
  credentialNonce: z.string().min(1),
  /**
   * The value of the one choice a connector declares, as the person made it
   * before the sign-in ("Ask a connection's one choice on connecting, and
   * change it later", issue 942) - opaque here, and written by the callback
   * route only after it has checked it against the connector's options.
   * Absent for a connector that asks nothing; on a reconnect, absent leaves
   * the stored one alone.
   */
  choice: z.string().min(1).max(200).optional(),
  /**
   * Whether the connection files what it brings in on the Panel named after
   * its label or category, as the person answered it before the sign-in
   * ("Ask on Connect whether a mail connection files by label or category",
   * issue 1147). Written by the callback route only for a connector that
   * reports names. Absent: a new connection starts off, and a reconnect leaves
   * the stored one alone.
   */
  filesByName: z.boolean().optional(),
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
 * set_connection_choice - the one choice a connection made, changed without
 * connecting again ("Ask a connection's one choice on connecting, and change it
 * later", issue 942). The value is opaque to the store and checked against the
 * connector's options by the route before this is applied; naming another
 * Workspace's connection is refused. Changing it drops any open state still
 * waiting to reach the source, which a change under the old choice no longer
 * applies to; choosing the one already held changes nothing.
 */
export const setConnectionChoiceSchema = commandEnvelopeSchema.extend({
  sourceAccountId: z.string().min(1),
  choice: z.string().min(1).max(200),
});
export type SetConnectionChoiceCommand = z.infer<typeof setConnectionChoiceSchema>;

/**
 * set_connection_files_by_name - whether a connection files what it brings in
 * on the Panel named after its label or category, skipping the Inbox ("File
 * Outlook mail on the Panel named after its category", issue 1146). Offered
 * by the route only for a connector that reports names; naming another
 * Workspace's connection is refused. Switching it on files nothing already in:
 * only a name new since then does.
 */
export const setConnectionFilesByNameSchema = commandEnvelopeSchema.extend({
  sourceAccountId: z.string().min(1),
  filesByName: z.boolean(),
});
export type SetConnectionFilesByNameCommand = z.infer<typeof setConnectionFilesByNameSchema>;

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
 * remember_sentence - a sentence the person pressed *Remember* on, offered
 * after an edit made before Open ("Remember an edit as a sentence you
 * confirm", issue 1163). `sentence` is as they left it, reworded or not.
 * The envelope's `workspaceId` is the Workspace the sentence names, or
 * `ACCOUNT_WIDE` for one that applies to every Workspace. `sourceKind` is
 * where the Item the edit was on came from, which is how a later proposal knows
 * the kind of action it fits. The same `sentenceId` again is the same sentence.
 */
export const rememberSentenceSchema = commandEnvelopeSchema.extend({
  sentenceId: z.uuid(),
  sentence: z.string().trim().min(1).max(REMEMBERED_SENTENCE_LIMIT),
  action: z.string().trim().min(1).max(REMEMBERED_ACTION_LIMIT),
  sourceKind: z.string().min(1).max(100),
});
export type RememberSentenceCommand = z.infer<typeof rememberSentenceSchema>;

/**
 * edit_remembered_sentence - a remembered sentence reworded in Settings ("See
 * and change what Cockpit remembers", issue 1164). Only the words change: what
 * it applies to stays, and a different kind of action is a new sentence. The
 * envelope's `workspaceId` is `ACCOUNT_WIDE`, since a sentence is the account's.
 */
export const editRememberedSentenceSchema = commandEnvelopeSchema.extend({
  sentenceId: z.uuid(),
  sentence: z.string().trim().min(1).max(REMEMBERED_SENTENCE_LIMIT),
});
export type EditRememberedSentenceCommand = z.infer<typeof editRememberedSentenceSchema>;

/** delete_remembered_sentence - a remembered sentence forgotten; already gone is as good as done. */
export const deleteRememberedSentenceSchema = commandEnvelopeSchema.extend({
  sentenceId: z.uuid(),
});
export type DeleteRememberedSentenceCommand = z.infer<typeof deleteRememberedSentenceSchema>;

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
  set_panel_settings: setPanelSettingsSchema,
  delete_panel: deletePanelSchema,
  move_panel_to_dashboard: movePanelToDashboardSchema,
  set_panel_text: setPanelTextSchema,
  set_panel_read_only: setPanelReadOnlySchema,
  set_panel_never_propose: setPanelNeverProposeSchema,
  set_panel_format: setPanelFormatSchema,
  set_panel_filter: setPanelFilterSchema,
  set_panel_sort: setPanelSortSchema,
  save_layout: saveLayoutSchema,
  capture_item: captureItemSchema,
  move_item_to_panel: moveItemToPanelSchema,
  add_item_to_panel: addItemToPanelSchema,
  remove_item_from_panel: removeItemFromPanelSchema,
  set_done: setDoneSchema,
  set_started: setStartedSchema,
  send_item_to_claude: sendItemToClaudeSchema,
  report_claude_run: reportClaudeRunSchema,
  finish_agent_run: finishAgentRunSchema,
  set_dismissed: setDismissedSchema,
  associate: associateSchema,
  set_next_action: setNextActionSchema,
  set_priority: setPrioritySchema,
  set_due_date: setDueDateSchema,
  set_title: setTitleSchema,
  set_description: setDescriptionSchema,
  add_attachment: addAttachmentSchema,
  remove_attachment: removeAttachmentSchema,
  set_item_form_presentation: setItemFormPresentationSchema,
  propose_item_texts: proposeItemTextsSchema,
  propose_item_panel: proposeItemPanelSchema,
  propose_item_fields: proposeItemFieldsSchema,
  propose_item_for_claude: proposeItemForClaudeSchema,
  connect_source_account: connectSourceAccountSchema,
  disconnect_source_account: disconnectSourceAccountSchema,
  set_connection_choice: setConnectionChoiceSchema,
  set_connection_files_by_name: setConnectionFilesByNameSchema,
  set_duplicate_settled: setDuplicateSettledSchema,
  remember_sentence: rememberSentenceSchema,
  edit_remembered_sentence: editRememberedSentenceSchema,
  delete_remembered_sentence: deleteRememberedSentenceSchema,
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
  | 'propose_item_fields'
  | 'propose_item_for_claude'
  // Sent by the callback Microsoft returns to, which is a navigation rather
  // than a request a page makes - and which carries a sealed credential no
  // browser may ever hand over (see `connectSourceAccountSchema` above).
  | 'connect_source_account'
  // Sent by the `report_run` MCP tool (see `reportClaudeRunSchema` above).
  | 'report_claude_run';

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
 * `fieldsSet` is present only for `propose_item_fields`, and only where it
 * applied: the fields it set, each refused or set on its own, read off the
 * same atomic call by the job that records what it changed ("Read a priority
 * you say when you capture", issue 1076). Where it filed the Item on Panels
 * the note named, `settledRouting` is `true` as for a person's first filing
 * (issue 1116).
 *
 * All absent, not `false`, everywhere else - every other command answers
 * `applied` alone, exactly as before any of them existed.
 */
export const commandResultSchema = z.object({
  ok: z.literal(true),
  applied: z.boolean(),
  settledRouting: z.boolean().optional(),
  recordedCorrection: z.boolean().optional(),
  fieldsSet: z
    .object({
      priority: prioritySchema.optional(),
      dueDate: z.iso.date().optional(),
      workspaceId: z.string().min(1).optional(),
      filedOnPanelIds: z.array(z.string().min(1)).optional(),
    })
    .optional(),
});
export type CommandResult = z.infer<typeof commandResultSchema>;
