import { z } from 'zod';
import {
  associationSchema,
  dashboardSchema,
  itemSchema,
  workspaceSchema,
} from '../domain/item.js';
import { itemTypeSchema } from '../domain/item-type.js';
import { filingSchema, layoutSchema, panelSchema } from '../domain/panel.js';

/**
 * The read model (architecture, "The read model: persisted snapshot,
 * revalidate, push"): one snapshot call per workspace. The client derives every
 * panel locally from this; there are no fine-grained item resources.
 */
export const workspaceSnapshotSchema = z.object({
  workspace: workspaceSchema,
  /** Open items only: tombstoned and dismissed items are excluded server-side. */
  items: z.array(itemSchema),
  /**
   * The workspace's dashboards, oldest first, so the bar under the workspace
   * tabs is derived from the snapshot the client already reads rather than from
   * a second call with its own revalidation to get wrong ("Add and switch
   * dashboards", issue 32).
   */
  dashboards: z.array(dashboardSchema),
  /**
   * Every panel of every dashboard of this workspace, oldest first, and every
   * layout that arranges them ("Panels on a dashboard, with per-screen-size
   * layouts", issue 33).
   *
   * All of the workspace's dashboards rather than only the one being looked at,
   * because the snapshot is the workspace's read model and the client switches
   * between dashboards without a round trip (architecture, "The read model:
   * persisted snapshot, revalidate, push"). It is also what lets a dashboard's
   * settings page say how many panels deleting one takes with it, from the same
   * copy the bar is drawn from.
   */
  panels: z.array(panelSchema),
  layouts: z.array(layoutSchema),
  /**
   * Which Items are filed on which of those Panels, and in what order
   * ("Panels hold the items filed into them, and the Inbox holds the rest",
   * issue 36).
   *
   * A flat list rather than items nested under each panel, because an Item can
   * be filed on several Panels and nesting would send it once per Panel. What a
   * Panel holds and what the Inbox holds are both derived from this in the
   * client, the way every other panel-shaped view already is.
   *
   * Filings of deleted Panels are left out server-side, like the Panels
   * themselves, so an Item whose only Panel has gone is back in the Inbox
   * without the client knowing anything about deletion.
   */
  filings: z.array(filingSchema),
  associations: z.array(associationSchema),
  /**
   * Every live Type of the account, in the order they are offered in ("Capture
   * a thought or an action, and see which it is", issue 155).
   *
   * In the workspace's snapshot although types belong to the account, because
   * every screen that draws an item needs them and this is the one call a
   * workspace makes: a second resource would be a second thing to revalidate
   * and a second chance for a row to be drawn before its type has arrived.
   */
  itemTypes: z.array(itemTypeSchema),
  generatedAt: z.iso.datetime(),
});
export type WorkspaceSnapshot = z.infer<typeof workspaceSnapshotSchema>;

export const workspaceListSchema = z.object({
  workspaces: z.array(workspaceSchema),
});
export type WorkspaceList = z.infer<typeof workspaceListSchema>;
