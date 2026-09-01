import { z } from 'zod';
import {
  associationSchema,
  dashboardSchema,
  itemSchema,
  workspaceSchema,
} from '../domain/item.js';

/**
 * The read model (architecture §5.2): one snapshot call per workspace.
 * The client derives every panel locally from this; there are no
 * fine-grained item resources.
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
  associations: z.array(associationSchema),
  generatedAt: z.iso.datetime(),
});
export type WorkspaceSnapshot = z.infer<typeof workspaceSnapshotSchema>;

export const workspaceListSchema = z.object({
  workspaces: z.array(workspaceSchema),
});
export type WorkspaceList = z.infer<typeof workspaceListSchema>;
