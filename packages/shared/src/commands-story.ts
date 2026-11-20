import { z } from 'zod';
import { commandEnvelopeSchema } from './commands.js';
import { DESCRIPTION_MAX_LENGTH } from './domain/item.js';

/**
 * The commands that keep a parent's story ("Brainstorming: a parent's
 * description goes stale as children join or leave", issue 1827), registered
 * beside `commandSchemas` but kept in an entry point of their own
 * (`@cockpit/shared/story-commands`), outside the package's index, for the
 * reason `commands-combine.ts` gives: the API mounts the schemas, the app only
 * needs their types.
 *
 * `itemId` is a parent Item or a Panel's own Item, whose id is the Panel's.
 */

/** set_keeps_story - *Keep its story up to date* ticked or cleared in a Panel's menu, stored per Item. */
export const setKeepsStorySchema = commandEnvelopeSchema.extend({
  itemId: z.uuid(),
  keepsStory: z.boolean(),
});
export type SetKeepsStoryCommand = z.infer<typeof setKeepsStorySchema>;

/**
 * rewrite_story - *Rewrite from its children*, once, whatever the setting. It
 * writes nothing itself: the route queues the rewrite, which arrives as
 * `propose_story`.
 */
export const rewriteStorySchema = commandEnvelopeSchema.extend({ itemId: z.uuid() });
export type RewriteStoryCommand = z.infer<typeof rewriteStorySchema>;

/** use_story - *Use it* on a Review: Claude's new version becomes the description, which stays yours. */
export const useStorySchema = commandEnvelopeSchema.extend({ itemId: z.uuid() });
export type UseStoryCommand = z.infer<typeof useStorySchema>;

/** keep_my_story - *Keep mine* on a Review: Claude's new version is dropped and the description stays as it is. */
export const keepMyStorySchema = commandEnvelopeSchema.extend({ itemId: z.uuid() });
export type KeepMyStoryCommand = z.infer<typeof keepMyStorySchema>;

/**
 * propose_story - Claude's rewrite, sent by the enrichment job. Replaces the
 * description while it is still Claude's; once it is yours it is held as the
 * Item's `storyProposal` for a Review instead.
 */
export const proposeStorySchema = commandEnvelopeSchema.extend({
  itemId: z.uuid(),
  story: z.string().trim().min(1).max(DESCRIPTION_MAX_LENGTH),
});
export type ProposeStoryCommand = z.infer<typeof proposeStorySchema>;

export const storyCommandSchemas = {
  set_keeps_story: setKeepsStorySchema,
  rewrite_story: rewriteStorySchema,
  use_story: useStorySchema,
  keep_my_story: keepMyStorySchema,
  propose_story: proposeStorySchema,
} as const;
