import type { Item } from '@cockpit/shared';

/**
 * Whether two Items say the same thing, and what an Item's own words are for
 * the purpose ("Flag a captured note that says what another one already said",
 * issue 407).
 *
 * Pure, and here rather than in `accounts/`, for the reason every other rule in
 * `domain/` is: what counts as saying the same thing is a product decision, and
 * the store is only where the rows are.
 */

/**
 * How alike two notes have to read before one is offered as a possible
 * duplicate of the other.
 *
 * **It starts conservative - few flags, all of them right - because there is no
 * labelled corpus here to tune it against.** A mark that is wrong costs the
 * person the moment it takes to see that the two notes are not the same thing,
 * on every note; a mark that is missing costs nothing they were not already
 * paying. Lowering it is what "Say a pair is not a duplicate" (issue 408) makes
 * survivable, and what a corpus would make measurable.
 *
 * Placed against `bge-m3` on four readings of one note: the same words twice
 * scored 1.00, the same thing in different English words 0.97, the same thing
 * in Dutch 0.93, and an unrelated note 0.36. This sits below the
 * across-languages case - the one this feature exists for - and nowhere near
 * the unrelated one.
 */
export const SAYS_THE_SAME_THING = 0.88;

/**
 * Whether an Item is one somebody could still act on: not finished with, and
 * not dismissed (which is what deleting one does - functional definition,
 * "Delete/Dismiss").
 *
 * **The same rule the store asks of a row** (`couldStillBeActedOn`,
 * accounts/repo.ts), asked here of an Item in hand - so a note that has gone
 * between being queued for reading and the reading arriving costs no call to
 * the model, and writes no pair that nothing could ever draw.
 *
 * A note brought back is read again the next time its texts change, which is
 * what queues a reading at all; the operator's own command is what reads the
 * rest ("Give every item already there a vector", issue 409).
 */
export function couldStillBeActedOn(item: Pick<Item, 'completedAt' | 'deletedAt'>): boolean {
  return item.completedAt === null && item.deletedAt === null;
}

/**
 * The two texts an Item shows, as one text to read - its Title and its
 * Description, which are the texts Cockpit proposed where it proposed any and
 * the ones capture wrote where it did not (`applyProposedTexts`,
 * domain/items.ts).
 *
 * **The captured message is deliberately not among them.** It is the record of
 * what somebody actually typed and never changes, so reading it would mean two
 * notes that Cockpit has since read into the same words still counting as
 * different - and an edit to the texts a person can actually see moving
 * nothing.
 *
 * Null where there is nothing to read: an Item whose two texts are empty or
 * only whitespace is not a note that means something obscure, it is a note with
 * nothing in it, and asking a model about it spends a call to be told so.
 */
export function whatAnItemSays(item: Pick<Item, 'title' | 'description'>): string | null {
  const said = [item.title, item.description ?? ''].map((text) => text.trim()).filter(Boolean);
  return said.length > 0 ? said.join('\n\n') : null;
}

/**
 * How alike two readings are, between -1 and 1 - the cosine of the angle
 * between them, which is the measure the models that produce them are trained
 * against.
 *
 * Zero for a pair that cannot be compared: two readings of different lengths,
 * or one that is all zeroes and so points nowhere. Neither can happen between
 * two readings of the same model, which is what the store compares within.
 */
export function howAlike(one: readonly number[], other: readonly number[]): number {
  if (one.length === 0 || one.length !== other.length) return 0;
  let dot = 0;
  let oneLength = 0;
  let otherLength = 0;
  for (let at = 0; at < one.length; at += 1) {
    dot += one[at]! * other[at]!;
    oneLength += one[at]! * one[at]!;
    otherLength += other[at]! * other[at]!;
  }
  if (oneLength === 0 || otherLength === 0) return 0;
  return dot / (Math.sqrt(oneLength) * Math.sqrt(otherLength));
}

/** Whether two readings are close enough to offer the one as a duplicate of the other. */
export function saysTheSameThing(one: readonly number[], other: readonly number[]): boolean {
  return howAlike(one, other) >= SAYS_THE_SAME_THING;
}

/**
 * Which of `others` say the same thing as `reading`, and how alike each is - the
 * whole of what one Item's set of pairs is recomputed from, in the order they
 * were given.
 */
export function saidAgainBy(
  reading: readonly number[],
  others: readonly { itemId: string; reading: readonly number[] }[],
): { itemId: string; howAlike: number }[] {
  return others
    .map((other) => ({ itemId: other.itemId, howAlike: howAlike(reading, other.reading) }))
    .filter((scored) => scored.howAlike >= SAYS_THE_SAME_THING);
}

/**
 * A pair as the store holds it: the smaller id first, so the same two Items are
 * one row whichever of them was read last.
 *
 * The database holds the same rule as a CHECK (`itemDuplicates`,
 * accounts/schema.ts) - this is what every writer goes through so that it never
 * has to fire.
 */
export function pairOf(one: string, other: string): { itemId: string; otherItemId: string } {
  return one < other ? { itemId: one, otherItemId: other } : { itemId: other, otherItemId: one };
}
