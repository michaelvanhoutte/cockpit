import { z } from 'zod';
import { associationSchema, itemSchema, workspaceSchema } from '../domain/item.js';

/**
 * The read model (architecture §5.2): one snapshot call per workspace.
 * The client derives every panel locally from this; there are no
 * fine-grained item resources.
 */
export const workspaceSnapshotSchema = z.object({
  workspace: workspaceSchema,
  /** Open items only: tombstoned and dismissed items are excluded server-side. */
  items: z.array(itemSchema),
  associations: z.array(associationSchema),
  generatedAt: z.iso.datetime(),
});
export type WorkspaceSnapshot = z.infer<typeof workspaceSnapshotSchema>;

export const workspaceListSchema = z.object({
  workspaces: z.array(workspaceSchema),
});
export type WorkspaceList = z.infer<typeof workspaceListSchema>;
