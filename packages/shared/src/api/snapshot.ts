import { z } from 'zod';
import { agentRunSchema } from '../domain/agent-run.js';
import { attachmentSchema } from '../domain/attachment.js';
import { possibleDuplicateSchema } from '../domain/duplicate.js';
import { emailToCockpitSchema } from '../domain/email-address.js';
import {
  FOLLOW_UP_DAYS,
  associationSchema,
  dashboardSchema,
  followUpDaysSchema,
  itemSchema,
  workspaceSchema,
} from '../domain/item.js';
import {
  DEFAULT_ITEM_FORM_PRESENTATION,
  itemFormPresentationSchema,
} from '../domain/item-form-presentation.js';
import { filingSchema, layoutSchema, panelSchema } from '../domain/panel.js';
import { seriesSchema } from '../domain/series.js';

/**
 * The read model (architecture.md, "The read model: persisted snapshot,
 * revalidate, push"; §4.4, "packages/shared: schema and command rationale",
 * for field-by-field rationale): one snapshot call per workspace. The client
 * derives every panel locally from this; there are no fine-grained item
 * resources.
 */
export const workspaceSnapshotSchema = z.object({
  workspace: workspaceSchema,
  /**
   * Open Items and Items finished in the last 24 hours ("Open a Workspace
   * without its finished Items", issue 1435): the day keeps Undo of Done and an
   * open form working. Dismissed Items and every other finished one are left out
   * server-side, a finished one with its filings, files and associations; those
   * come from `finishedItemsSchema`'s own read.
   */
  items: z.array(itemSchema),
  /**
   * How many finished Items `items` leaves out, so deleting the Workspace still
   * names every Item it hides. Optional: a copy saved by a release that did not
   * send it carried every finished Item, and leaves none out.
   */
  finishedItemsLeftOut: z.number().int().nonnegative().optional(),
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
  /**
   * The series the Items above name ("Repeat an Item on a schedule, so it
   * comes back every Monday or every quarter", issue 1405) - stopped ones too,
   * since an Item still names the series deleting its recurring item stopped. Defaulted for the
   * reason `attachments` above is: a stored copy taken before this field
   * existed is an app with nothing repeating.
   */
  series: z.array(seriesSchema).default([]),
  /**
   * How the account has the Item's form drawn - centered, or docked to the
   * side ("Let the item's form dock to the side of the screen instead of
   * opening as a dialog", issue 481). Account-wide,
   * defaulted for the reason `attachments` above is: a stored copy taken
   * before this field existed opens centered, the only presentation there
   * was.
   */
  itemFormPresentation: itemFormPresentationSchema.default(DEFAULT_ITEM_FORM_PRESENTATION),
  /**
   * How many days *Wait for reply…* starts on, from Settings › Follow-ups
   * ("Choose in Settings how many days to wait for a reply", issue 1465).
   * Account-wide, carried here as `itemFormPresentation` is so the question has
   * it offline and on a cold open; defaulted for the reason `attachments` above
   * is: a stored copy taken before this field existed starts on 3.
   */
  followUpDays: followUpDaysSchema.default(FOLLOW_UP_DAYS),
  /**
   * The account's Email to Cockpit address, and where this environment
   * receives mail ("Get an Email to Cockpit address, and receive mail at it",
   * issue 1466). Account-wide, carried here as `followUpDays` is, so the *Your
   * account* panel draws it offline and *Get an address* causes no read of its
   * own. Null where the environment receives no mail; optional rather than
   * defaulted, as `sourceNames` below is, so a copy saved by a release that did
   * not send it draws no panel until it is read again.
   */
  emailToCockpit: emailToCockpitSchema.nullable().optional(),
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
  /**
   * Every open run on this Workspace's Items - at most one per Item: an Item
   * sent to Claude, or one an Agent started before Agents were retired
   * ("Retire the agents' dock and routines, keeping what each agent knew",
   * issue 1165).
   */
  agentRuns: z.array(agentRunSchema).default([]),
  /**
   * What each source is called on screen, by its connector id ("Take source
   * names out of the shared contract", issue 927): every connector
   * Cockpit carries, by its manifest's name, whether or not this environment
   * configures it. Carried here so a cold
   * open draws the names from the stored copy with no request of its own. An
   * id missing from it reads as itself; `internal` and `mcp` are never in it.
   * Optional rather than defaulted, unlike `attachments` above, so a copy saved
   * by a release that did not send it is drawn without names, as itself.
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

/**
 * A Workspace's finished Items ("Fetch a Workspace's finished Items the first
 * time All items opens", issue 1434): a read of its own, made when *All items*
 * is first opened in a tab or an address names an Item the Workspace's read does
 * not hold, and the only one carrying an Item finished more than a day ago. The Items are the
 * Workspace's finished and not dismissed ones, with what *All items* draws a row
 * from: where each is filed (`filings`) and whether it holds a file
 * (`attachments`). Panels and Dashboards come with the snapshot.
 */
export const finishedItemsSchema = z.object({
  items: z.array(itemSchema),
  filings: z.array(filingSchema),
  attachments: z.array(attachmentSchema),
  /** The newest change this read is built on, as the snapshot's `upTo` says it. */
  upTo: z.iso.datetime().optional(),
});
export type FinishedItems = z.infer<typeof finishedItemsSchema>;

export const workspaceListSchema = z.object({
  workspaces: z.array(workspaceSchema),
});
export type WorkspaceList = z.infer<typeof workspaceListSchema>;
