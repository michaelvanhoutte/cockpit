import { z } from 'zod';
import {
  associationSchema,
  dashboardSchema,
  itemSchema,
  workspaceSchema,
} from '../domain/item.js';
import { layoutSchema, panelSchema } from '../domain/panel.js';

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
  associations: z.array(associationSchema),
  generatedAt: z.iso.datetime(),
});
export type WorkspaceSnapshot = z.infer<typeof workspaceSnapshotSchema>;

export const workspaceListSchema = z.object({
  workspaces: z.array(workspaceSchema),
});
export type WorkspaceList = z.infer<typeof workspaceListSchema>;
