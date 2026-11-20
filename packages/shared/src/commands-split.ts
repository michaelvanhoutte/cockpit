import { z } from 'zod';
import { commandEnvelopeSchema } from './commands.js';
import { DESCRIPTION_MAX_LENGTH, itemTitleSchema } from './domain/item.js';
import { SPLIT_ITEMS_AT_ONCE } from './domain/split.js';

/**
 * The commands Split sends ("Brainstorming: a note holding several ideas can't
 * be taken apart", issue 1828), registered beside `commandSchemas` but kept in
 * an entry point of their own (`@cockpit/shared/split-commands`), outside the
 * package's index, for the reason `commands-combine.ts` gives.
 */

/**
 * split_item — **Split**: the Item named holds the new Items made from it, each
 * one the blocks of a card the dialog drew (`splitBlocksOf`). A new Item is
 * inside the original (`item_children`) and filed on no Panel. Its paragraphs
 * leave the original's description, its Additions and files move to it, and the
 * original keeps everything no card took. A card with no block makes an Item
 * holding its title.
 *
 * `was` is the description the dialog was drawn from: a Split of words that
 * changed since is refused, as the blocks it names would be other words.
 * Sent twice, it applies once.
 */
export const splitItemSchema = commandEnvelopeSchema
  .extend({
    itemId: z.uuid(),
    was: z.string().max(DESCRIPTION_MAX_LENGTH),
    children: z
      .array(
        z.object({
          itemId: z.uuid(),
          title: itemTitleSchema.min(1),
          blockIds: z.array(z.string().min(1).max(60)).max(1_000),
        }),
      )
      .min(1)
      .max(SPLIT_ITEMS_AT_ONCE),
  })
  .refine((cmd) => new Set(cmd.children.map((child) => child.itemId)).size === cmd.children.length && !cmd.children.some((child) => child.itemId === cmd.itemId), {
    message: 'each new item once, and not the original',
    path: ['children'],
  })
  .refine((cmd) => new Set(cmd.children.flatMap((child) => child.blockIds)).size === cmd.children.flatMap((child) => child.blockIds).length, {
    message: 'each block in one card only',
    path: ['children'],
  });
export type SplitItemCommand = z.infer<typeof splitItemSchema>;

/**
 * unsplit_item — Undo of a Split: the new Items named are dismissed, and what
 * they were made from comes back, in one change. `children` is what the Split
 * moved into each, which the store checks against what the new Item holds now,
 * so nothing else is touched; `description` is the original's as it was, put
 * back only where the original still reads as the Split left it (`kept`).
 * Sent twice, it applies once.
 */
export const unsplitItemSchema = commandEnvelopeSchema.extend({
  itemId: z.uuid(),
  description: z.string().max(DESCRIPTION_MAX_LENGTH).nullable(),
  kept: z.string().max(DESCRIPTION_MAX_LENGTH).nullable(),
  children: z
    .array(
      z.object({
        itemId: z.uuid(),
        additionIds: z.array(z.uuid()).max(1_000),
        attachmentIds: z.array(z.uuid()).max(1_000),
      }),
    )
    .min(1)
    .max(SPLIT_ITEMS_AT_ONCE),
});
export type UnsplitItemCommand = z.infer<typeof unsplitItemSchema>;

export const splitCommandSchemas = {
  split_item: splitItemSchema,
  unsplit_item: unsplitItemSchema,
} as const;
