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
 * unmerge_items — a Merge undone, in one change ("Brainstorming: related loose notes can't be brought together", issue 1826): the originals
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
 * Combine made from a Dashboard ("Brainstorming: cards on the whiteboard can't
 * be nested, combined or moved between boxes", issue 1830): the Dashboard's
 * whiteboard and the id the new parent's card is made with. Where the first
 * Item has a card on that board, the new parent gets a card at its spot, in its
 * box, and the cards of the Items it now holds come off that board, since the
 * parent's card unfolds to them; where the first has none, or the parent lands
 * in the Inbox, which no board holds, nothing is placed.
 */
const onBoardSchema = z.object({ dashboardId: z.string().min(1), cardId: z.uuid() });

/**
 * combine_under_new_parent — **Combine ▸ Combine under a new parent** (issue
 * 1826): the Items stay where they are and a new Item holds them, placed
 * where the first Item is ("Brainstorming: a Panel is an Item nobody can
 * open", issue 1846). With `panelId` it is filed on that Panel, the one the
 * first Item was on, as a row there; without, it goes inside the Item the
 * first Item is inside, which the store finds itself, or else it is filed
 * nowhere and stays in the Inbox holding them. Its *Keep its story up to
 * date* is stored as on. `parentId` is the
 * new Item. `dashboardId` is sent as null and read by nothing: a tab of the
 * release before sends the Dashboard it had open, which made a new Panel then
 * and makes nothing different now, and a Worker of that release, met during a
 * rollout, still requires the field.
 */
export const combineUnderNewParentSchema = commandEnvelopeSchema
  .extend({
    parentId: z.uuid(),
    title: panelNameSchema,
    description: itemDescriptionSchema.nullable(),
    childIds: z.array(z.uuid()).min(2).max(CHILDREN_ADDED_AT_ONCE),
    panelId: z.uuid().nullable(),
    dashboardId: z.string().nullable(),
    onBoard: onBoardSchema.optional(),
  })
  .refine((cmd) => eachOnce(cmd.childIds, cmd.parentId), { message: 'each item once, and not the new parent', path: ['childIds'] })
  .refine((cmd) => cmd.panelId === null || cmd.dashboardId === null, {
    message: 'a Panel or a Dashboard, not both',
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
