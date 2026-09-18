import { z } from 'zod';
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
import { routingSummarySchema } from '../domain/routing-summary.js';
import { screenSizeSchema } from '../domain/screen-size.js';

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
  /** Every panel of every dashboard of this workspace, and every layout that arranges them ("Panels on a dashboard, with per-screen-size layouts", issue 33; architecture.md §4.4). */
  panels: z.array(panelSchema),
  layouts: z.array(layoutSchema),
  /** Which Items are filed on which of those Panels, and in what order ("Panels hold the items filed into them, and the Inbox holds the rest", issue 36; architecture.md §4.4). */
  filings: z.array(filingSchema),
  associations: z.array(associationSchema),
  /**
   * Every file attached to an Item of this Workspace ("Attach a file to an
   * item", issue 441) - metadata only, never the bytes, which live in R2.
   * Defaulted for the reason `screenSizes` below is: a stored copy taken
   * before this field existed is an app with nothing attached, not a broken
   * one.
   */
  attachments: z.array(attachmentSchema).default([]),
  /** Every live Type of the account, in the order they are offered in ("Capture a thought or an action, and see which it is", issue 155; architecture.md §4.4). */
  itemTypes: z.array(itemTypeSchema),
  /** Every Screen size of the account, narrowest first ("Give the account a list of screen sizes, before anything reads it", issue 262; architecture.md §4.4). Empty until "Draw a dashboard against the screen sizes its account has" (issue 263). */
  screenSizes: z.array(screenSizeSchema).default([]),
  /**
   * How the account has the Item's form drawn - centered, or docked to the
   * side ("Let the item's form dock to the side of the screen instead of
   * opening as a dialog", issue 481). Account-wide like `itemTypes` above,
   * defaulted for the reason `screenSizes` above is: a stored copy taken
   * before this field existed opens centered, the only presentation there
   * was.
   */
  itemFormPresentation: itemFormPresentationSchema.default(DEFAULT_ITEM_FORM_PRESENTATION),
  /**
   * This Workspace's own sentence about where its notes belong ("Show what
   * the system learned, in a sentence you can correct", issue 301). Null
   * where no row exists yet, which is every Workspace nobody has written one
   * for.
   *
   * **Narrower than it was**: the generated summary that used to ride along
   * here is gone, along with the nightly job that wrote it ("Drop the nightly
   * filing summary, keep the sentence you wrote", issue 392).
   */
  routingSummary: routingSummarySchema.nullable().default(null),
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
   * Defaulted for the reason `screenSizes` above is: a stored copy taken
   * before this field existed is an app with nothing flagged, not a broken one.
   */
  duplicates: z.array(possibleDuplicateSchema).default([]),
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
