import { z } from 'zod';
import { agentSchema, hiddenAgentSchema } from '../domain/agent.js';
import { agentRunSchema } from '../domain/agent-run.js';
import { attachmentSchema } from '../domain/attachment.js';
import { possibleDuplicateSchema } from '../domain/duplicate.js';
import {
  associationSchema,
  dashboardSchema,
  itemSchema,
  workspaceSchema,
} from '../domain/item.js';
import {
  DEFAULT_ITEM_FORM_PRESENTATION,
  itemFormPresentationSchema,
} from '../domain/item-form-presentation.js';
import { itemTypeSchema } from '../domain/item-type.js';
import { filingSchema, layoutSchema, panelSchema } from '../domain/panel.js';

/**
 * The read model (architecture.md, "The read model: persisted snapshot,
 * revalidate, push"; §4.4, "packages/shared: schema and command rationale",
 * for field-by-field rationale): one snapshot call per workspace. The client
 * derives every panel locally from this; there are no fine-grained item
 * resources.
 */
export const workspaceSnapshotSchema = z.object({
  workspace: workspaceSchema,
  /** Open items only: tombstoned and dismissed items are excluded server-side. */
  items: z.array(itemSchema),
  /** The workspace's dashboards, oldest first ("Add and switch dashboards", issue 32; architecture.md §4.4). */
  dashboards: z.array(dashboardSchema),
  /** Every panel of every dashboard of this workspace ("Panels on a dashboard, with per-screen-size layouts", issue 33; architecture.md §4.4). */
  panels: z.array(panelSchema),
  /** Each of those dashboards' one Layout, for the ones that have been arranged - never more than one per dashboard ("Convert every Dashboard to its widest Layout and retire Screen sizes", issue 713). */
  layouts: z.array(layoutSchema),
  /** Which Items are filed on which of those Panels, and in what order ("Panels hold the items filed into them, and the Inbox holds the rest", issue 36; architecture.md §4.4). */
  filings: z.array(filingSchema),
  associations: z.array(associationSchema),
  /**
   * Every file attached to an Item of this Workspace ("Attach a file to an
   * item", issue 441) - metadata only, never the bytes, which live in R2.
   * Defaulted because a stored copy taken before this field existed is an app
   * with nothing attached, not a broken one.
   */
  attachments: z.array(attachmentSchema).default([]),
  /** Every live Type of the account, in the order they are offered in ("Capture a thought or an action, and see which it is", issue 155; architecture.md §4.4). */
  itemTypes: z.array(itemTypeSchema),
  /**
   * How the account has the Item's form drawn - centered, or docked to the
   * side ("Let the item's form dock to the side of the screen instead of
   * opening as a dialog", issue 481). Account-wide like `itemTypes` above,
   * defaulted for the reason `attachments` above is: a stored copy taken
   * before this field existed opens centered, the only presentation there
   * was.
   */
  itemFormPresentation: itemFormPresentationSchema.default(DEFAULT_ITEM_FORM_PRESENTATION),
  /**
   * Which of the Items above say the same thing as which ("Flag a captured
   * note that says what another one already said", issue 407) - the pairs
   * themselves, never the vectors behind them.
   *
   * **Only pairs both of whose Items are in `items` above.** The store leaves
   * out everything a person could no longer act on and everything belonging to
   * another Workspace, so a pair here always names two rows this snapshot
   * already carries. Which of them are actually *marked* is a step further -
   * a filed Item is nothing's duplicate yet (`possibleDuplicatesOf`,
   * apps/web/src/duplicates.ts).
   *
   * Defaulted for the reason `attachments` above is: a stored copy taken
   * before this field existed is an app with nothing flagged, not a broken one.
   */
  duplicates: z.array(possibleDuplicateSchema).default([]),
  /** Every live Agent of the account, in dock order ("Keep your agents in a dock, and choose which each dashboard shows", issue 570). Account-wide like `itemTypes` above. */
  agents: z.array(agentSchema).default([]),
  /** Which Agents are hidden on which of this Workspace's Dashboards (issue 570). */
  hiddenAgents: z.array(hiddenAgentSchema).default([]),
  /** Whether this Workspace has a live Claude Code connection (issue 570). */
  hasClaudeCodeConnection: z.boolean().default(false),
  /** Every open run on this Workspace's Items ("Drop an agent on an item to start a Claude Code session on it", issue 571) - at most one per Item. */
  agentRuns: z.array(agentRunSchema).default([]),
  /** Why Claude last refused this Workspace's Claude Code connection, until a start works again (issue 571); null while it is not failing. */
  claudeCodeFailing: z.string().nullable().default(null),
  /**
   * What each source is called on screen, by its connector id ("Take source
   * names out of the shared contract", issue 927): every connector
   * Cockpit carries, by its manifest's name, whether or not this environment
   * configures it. Carried here so a cold
   * open draws the names from the stored copy with no request of its own. An
   * id missing from it reads as itself; `internal` and `mcp` are never in it.
   * Optional rather than defaulted, unlike `attachments` above: a stored copy
   * is restored without being parsed again, so one kept from a release that
   * did not send it lacks it, and the type says so.
   */
  sourceNames: z.record(z.string(), z.string()).optional(),
  generatedAt: z.iso.datetime(),
  /**
   * POC (own-event refetch): the newest change this snapshot is built on, as
   * the account's own store stamped it (architecture.md §4.4 — not
   * `generatedAt`, and a known monotonicity limit).
   */
  upTo: z.iso.datetime().optional(),
});
export type WorkspaceSnapshot = z.infer<typeof workspaceSnapshotSchema>;

export const workspaceListSchema = z.object({
  workspaces: z.array(workspaceSchema),
});
export type WorkspaceList = z.infer<typeof workspaceListSchema>;

/** The account's live Types, in the order they are offered in ("Manage the types, and put them in the order you want", issue 156). Its own call because the page that manages them is outside any workspace. */
export const itemTypeListSchema = z.object({
  itemTypes: z.array(itemTypeSchema),
});
export type ItemTypeList = z.infer<typeof itemTypeListSchema>;
