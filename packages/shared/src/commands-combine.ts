import { z } from 'zod';
import { commandEnvelopeSchema } from './commands.js';
import { CHILDREN_ADDED_AT_ONCE } from './domain/item-children.js';
import { itemDescriptionSchema, itemTitleSchema } from './domain/item.js';
import { panelNameSchema } from './domain/panel.js';

/**
 * The commands Combine sends ("Brainstorming: related loose notes can't be
 * brought together", issue 1826), registered beside `commandSchemas` but kept
 * in an entry point of their own (`@cockpit/shared/combine-commands`), outside
 * the package's index, so the app does not carry their schemas in its initial
 * bundle: the API mounts them, and the app only needs their types.
 */

/**
 * merge_items — several Items replaced by one new Item ("Brainstorming: related
 * loose notes can't be brought together", issue 1826): **Combine ▸ Merge**.
 * `itemId` is the new Item, its title and description as the dialog stitched
 * them (Claude writes them in a later issue), stored as a capture is: its own
 * until you edit it. Every original's captured words become Additions on it,
 * their attachments move to it, it is filed wherever any of them was, and the
 * originals are dismissed as merged into it. An Item from a source is refused.
 * `unmerge_items` reverses all of it.
 */
export const mergeItemsSchema = commandEnvelopeSchema
  .extend({
    itemId: z.uuid(),
    originalIds: z.array(z.uuid()).min(2).max(CHILDREN_ADDED_AT_ONCE),
    title: itemTitleSchema.min(1),
    description: itemDescriptionSchema.min(1),
  })
  .refine((cmd) => eachOnce(cmd.originalIds, cmd.itemId), { message: 'each item once, and not the new one', path: ['originalIds'] });
export type MergeItemsCommand = z.infer<typeof mergeItemsSchema>;

/**
 * unmerge_items — a Merge undone, in one change (issue 1826): the originals
 * named come back where they were, their files and words with them, and the
 * Item they were merged into is dismissed. `originalIds` is what the Merge
 * took, which the store checks against the trail on each row, so one never
 * merged into this Item is left alone. Sent twice, it applies once.
 */
export const unmergeItemsSchema = commandEnvelopeSchema
  .extend({
    itemId: z.uuid(),
    originalIds: z.array(z.uuid()).min(1).max(CHILDREN_ADDED_AT_ONCE),
  })
  .refine((cmd) => eachOnce(cmd.originalIds), { message: 'each item once', path: ['originalIds'] });
export type UnmergeItemsCommand = z.infer<typeof unmergeItemsSchema>;

/**
 * combine_under_new_parent — **Combine ▸ Combine under a new parent** (issue
 * 1826): the Items stay where they are and a new Item holds them. With
 * `panelId` it is a child Panel of that Panel, the one the first Item was on;
 * with `dashboardId` it is a new Panel on that Dashboard, which is where Items
 * from the Inbox go; with neither it is an Item of the Workspace's own. Its
 * *Keep its story up to date* is stored as on. `parentId` is the new Item, and
 * the new Panel's own id where it is one.
 */
export const combineUnderNewParentSchema = commandEnvelopeSchema
  .extend({
    parentId: z.uuid(),
    title: panelNameSchema,
    description: itemDescriptionSchema.nullable(),
    childIds: z.array(z.uuid()).min(2).max(CHILDREN_ADDED_AT_ONCE),
    panelId: z.uuid().nullable(),
    dashboardId: z.string().nullable(),
  })
  .refine((cmd) => eachOnce(cmd.childIds, cmd.parentId), { message: 'each item once, and not the new parent', path: ['childIds'] })
  .refine((cmd) => cmd.panelId === null || cmd.dashboardId === null, {
    message: 'a child Panel or a new Panel, not both',
    path: ['panelId'],
  });
export type CombineUnderNewParentCommand = z.infer<typeof combineUnderNewParentSchema>;

/** Whether no id is listed twice, and none is `besides`: what Combine's lists of Items hold to. */
const eachOnce = (ids: readonly string[], besides?: string) => new Set(ids).size === ids.length && !ids.includes(besides ?? '');

export const combineCommandSchemas = {
  merge_items: mergeItemsSchema,
  unmerge_items: unmergeItemsSchema,
  combine_under_new_parent: combineUnderNewParentSchema,
} as const;
