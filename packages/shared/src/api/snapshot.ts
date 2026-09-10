import { z } from 'zod';
import {
  associationSchema,
  dashboardSchema,
  itemSchema,
  workspaceSchema,
} from '../domain/item.js';
import { itemTypeSchema } from '../domain/item-type.js';
import { filingSchema, layoutSchema, panelSchema } from '../domain/panel.js';
import { screenSizeSchema } from '../domain/screen-size.js';

/**
 * The read model (architecture.md, "The read model: persisted snapshot,
 * revalidate, push"; §4.4 for field-by-field rationale): one snapshot call per
 * workspace. The client derives every panel locally from this; there are no
 * fine-grained item resources.
 */
export const workspaceSnapshotSchema = z.object({
  workspace: workspaceSchema,
  /** Open items only: tombstoned and dismissed items are excluded server-side. */
  items: z.array(itemSchema),
  /** The workspace's dashboards, oldest first (issue 32; architecture.md §4.4). */
  dashboards: z.array(dashboardSchema),
  /** Every panel of every dashboard of this workspace, and every layout that arranges them (issue 33; architecture.md §4.4). */
  panels: z.array(panelSchema),
  layouts: z.array(layoutSchema),
  /** Which Items are filed on which of those Panels, and in what order (issue 36; architecture.md §4.4). */
  filings: z.array(filingSchema),
  associations: z.array(associationSchema),
  /** Every live Type of the account, in the order they are offered in (issue 155; architecture.md §4.4). */
  itemTypes: z.array(itemTypeSchema),
  /** Every Screen size of the account, narrowest first (issue 262; architecture.md §4.4). Empty until issue 263. */
  screenSizes: z.array(screenSizeSchema).default([]),
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

/** The account's live Types, in the order they are offered in (issue 156). Its own call because the page that manages them is outside any workspace. */
export const itemTypeListSchema = z.object({
  itemTypes: z.array(itemTypeSchema),
});
export type ItemTypeList = z.infer<typeof itemTypeListSchema>;
