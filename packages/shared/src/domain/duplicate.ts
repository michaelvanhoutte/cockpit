import { z } from 'zod';

/**
 * Two Items that say the same thing, however differently they word it ("Flag a
 * captured note that says what another one already said", issue 407).
 *
 * **Two ids and nothing else.** What decided the pair is a vector of what each
 * Item's Title and Description mean, and a vector never leaves the account's
 * own store: a thousand numbers per Item would cost the snapshot far more than
 * the mark on a row is worth, and the screen needs no more than "this one, and
 * that one".
 *
 * **One row per pair, whichever of the two you are looking at.** The store
 * holds the smaller id first and refuses the same pair the other way round, so
 * a form opened on either Item finds the same row - which is why this is a pair
 * rather than a list hanging off one Item.
 */
export const possibleDuplicateSchema = z.object({
  itemId: z.uuid(),
  otherItemId: z.uuid(),
});
export type PossibleDuplicate = z.infer<typeof possibleDuplicateSchema>;

/**
 * The Items one Item may be saying again - the ids of the other half of every
 * pair it is in.
 *
 * Pure and here rather than in either app, for the reason every other view over
 * the snapshot is (`itemsInTheInbox`, apps/web/src/filing.ts): the wire carries
 * the pairs, and who is paired with whom is worked out where it is drawn.
 */
export function pairedWith(
  itemId: string,
  pairs: readonly PossibleDuplicate[],
): string[] {
  const others = pairs
    .filter((pair) => pair.itemId === itemId || pair.otherItemId === itemId)
    .map((pair) => (pair.itemId === itemId ? pair.otherItemId : pair.itemId));
  return [...new Set(others)];
}
