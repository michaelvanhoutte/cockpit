import { z } from 'zod';
import { itemDescriptionSchema, itemTitleSchema } from './item.js';

/**
 * A worked example of how a title and a message should be written for a
 * note, chosen deliberately rather than corrected after the fact ("Pin an
 * example of how you want a note written", issue 397; `docs/text-
 * learning.md`, "What is stored" - the "Pinned" kind).
 *
 * **Its own table, not a `kind` column on `text_corrections`** - why, in
 * `apps/api/src/accounts/schema.ts`'s own comment on `pinnedTextExamples`.
 *
 * **`note` reuses the captured-message shape** (`captureItemSchema.message`
 * in `commands.ts`), not `itemTitleSchema` - a pinned example's note is a
 * note, the same free-form, possibly-multi-line text capture accepts, not a
 * title.
 */
export const PINNED_EXAMPLE_NOTE_LENGTH = 60_000;
export const pinnedExampleNoteSchema = z.string().trim().min(1).max(PINNED_EXAMPLE_NOTE_LENGTH);

/** A pinned example always has a title - unlike an Item's, which a person may clear. */
export const pinnedExampleTitleSchema = itemTitleSchema.refine((title) => title.length > 0, {
  message: 'a pinned example needs a title',
});

/**
 * The empty string is what clears it, the same idiom `applySetDescription`
 * uses for an Item's own description - normalized to `null` on the way into
 * the row (`command-service.ts`), never stored as an empty string nothing
 * else in the product would distinguish from "none".
 */
export const pinnedExampleDescriptionSchema = itemDescriptionSchema;

/** One pinned example, as the window reads it back. */
export const pinnedExampleSchema = z.object({
  id: z.uuid(),
  note: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type PinnedExample = z.infer<typeof pinnedExampleSchema>;
