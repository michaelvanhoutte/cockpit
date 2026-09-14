import { describe, expect, it } from 'vitest';
import type { Item } from '@cockpit/shared';
import {
  SAYS_THE_SAME_THING,
  howAlike,
  pairOf,
  saidAgainBy,
  saysTheSameThing,
  whatAnItemSays,
} from '../../../src/domain/duplicates.js';
import { LONGEST_TEXT_READ, asFarAsItReads } from '../../../src/embeddings/index.js';

/**
 * L1: what decides that two notes say the same thing, and what an Item's own
 * words are for the purpose - both pure, so both provable here.
 *
 * **The readings below are fixed and made by hand**, at angles chosen to sit
 * where a real model put four readings of one note: the same words twice at
 * 1.00, the same thing in different English words at 0.97, the same thing in
 * Dutch at 0.93, and an unrelated note at 0.36 (`SAYS_THE_SAME_THING`). That a
 * real model actually separates them that way is the one thing a fixture cannot
 * say and the contract tier is for
 * (tests/contract/read-what-a-note-means.test.ts).
 */

/** A reading at a given angle from the first one, so its closeness is chosen rather than guessed. */
function atDegrees(degrees: number): number[] {
  const radians = (degrees * Math.PI) / 180;
  return [Math.cos(radians), Math.sin(radians)];
}

const THE_NOTE = atDegrees(0);

function anItem(overrides: Partial<Item> = {}): Pick<Item, 'title' | 'description'> {
  return { title: 'Ask Novy about part 11', description: null, ...overrides };
}

describe('Triage', () => {
  describe('an item is a possible duplicate of another when the two say the same thing, however differently they word it', () => {
    it.each([
      { situation: 'the same words twice', other: atDegrees(0), marked: true },
      { situation: 'the same meaning in different words', other: atDegrees(14.5), marked: true },
      { situation: 'the same meaning in another language', other: atDegrees(21), marked: true },
      { situation: 'two unrelated notes', other: atDegrees(68.6), marked: false },
    ])('$situation', ({ other, marked }) => {
      expect(saysTheSameThing(THE_NOTE, other)).toBe(marked);
    });

    /**
     * The cut-off itself, from both sides, so it is a line rather than a
     * direction: a pair exactly on it is offered and one a hair under it is
     * not. Without this the rule above passes for any cut-off between 0.37 and
     * 0.93.
     */
    it.each([
      { situation: 'exactly as alike as the cut-off asks', nudge: 0, marked: true },
      { situation: 'a hair more alike than that', nudge: 0.001, marked: true },
      { situation: 'a hair less alike than that', nudge: -0.001, marked: false },
    ])('$situation', ({ nudge, marked }) => {
      const other = atDegrees((Math.acos(SAYS_THE_SAME_THING + nudge) * 180) / Math.PI);
      expect(saysTheSameThing(THE_NOTE, other)).toBe(marked);
    });

    /**
     * Two readings that cannot be compared at all - different lengths, or one
     * that says nothing in any direction - are not "very alike", which is what
     * a naive dot product would call them. The store never compares two of
     * different lengths, so this is the guard rather than a case it meets.
     */
    it.each([
      { situation: 'one reading is shorter than the other', other: [1] },
      { situation: 'one reading points nowhere at all', other: [0, 0] },
      { situation: 'there is no reading at all', other: [] },
    ])('$situation is not alike', ({ other }) => {
      expect(howAlike(THE_NOTE, other)).toBe(0);
      expect(saysTheSameThing(THE_NOTE, other)).toBe(false);
    });

    it('offers only the notes that say the same thing, and says how alike each is', () => {
      const said = saidAgainBy(THE_NOTE, [
        { itemId: 'a', reading: atDegrees(14.5) },
        { itemId: 'b', reading: atDegrees(68.6) },
        { itemId: 'c', reading: atDegrees(0) },
      ]);

      expect(said.map((one) => one.itemId)).toEqual(['a', 'c']);
      expect(said[1]!.howAlike).toBeCloseTo(1, 5);
    });
  });

  describe('a pair is one pair, whichever of the two you are looking at', () => {
    it.each([
      { situation: 'the older one first', one: 'item-a', other: 'item-b' },
      { situation: 'the newer one first', one: 'item-b', other: 'item-a' },
    ])('$situation gives the same pair', ({ one, other }) => {
      expect(pairOf(one, other)).toEqual({ itemId: 'item-a', otherItemId: 'item-b' });
    });
  });

  describe('what is compared is the two texts an item shows', () => {
    it.each([
      {
        situation: 'a title alone',
        item: anItem({ title: 'Ask Novy about part 11' }),
        read: 'Ask Novy about part 11',
      },
      {
        situation: 'a title and a description',
        item: anItem({ title: 'Ask Novy', description: 'About the part 11 audit trail.' }),
        read: 'Ask Novy\n\nAbout the part 11 audit trail.',
      },
      {
        situation: 'a description alone',
        item: anItem({ title: '', description: 'About the part 11 audit trail.' }),
        read: 'About the part 11 audit trail.',
      },
    ])('$situation is read', ({ item, read }) => {
      expect(whatAnItemSays(item)).toBe(read);
    });

    it.each([
      { situation: 'an empty note', item: anItem({ title: '', description: null }) },
      { situation: 'a note of whitespace only', item: anItem({ title: '   ', description: '\n\t ' }) },
    ])('$situation is not read at all', ({ item }) => {
      expect(whatAnItemSays(item)).toBeNull();
    });

    it('reads a very long note, as far as it goes', () => {
      const long = 'x'.repeat(LONGEST_TEXT_READ * 2);
      const said = whatAnItemSays(anItem({ title: 'Long', description: long }));

      expect(said).not.toBeNull();
      expect(asFarAsItReads(said!)).toHaveLength(LONGEST_TEXT_READ);
      expect(asFarAsItReads('Short enough')).toBe('Short enough');
    });
  });
});
