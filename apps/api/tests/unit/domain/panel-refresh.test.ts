import { describe, expect, it } from 'vitest';
import {
  COULD_BE_CHANGED_BY_A_FILING,
  itemsToReadAgain,
  type CandidateMeaning,
} from '../../../src/domain/panel-refresh.js';

/**
 * L1: which unfiled Items a filing's refresh asks the model about again is a
 * pure choice over meanings ("Cut what cleaning up a captured note costs",
 * issue 887). That the job reads the meanings and the filings from a real
 * store is the integration tier's (`panel-refresh-selection.test.ts`).
 */

/** A unit vector at `degrees` from the first axis, so the cosine between two of them is the cosine of the difference. */
const meaning = (degrees: number): number[] => [Math.cos((degrees * Math.PI) / 180), Math.sin((degrees * Math.PI) / 180)];

const FILED = meaning(0);
const CLOSE = meaning(40);
const FAR = meaning(80);

/** Most recently captured first, as the job hands them over. */
const items = (...readings: (number[] | null)[]): CandidateMeaning[] =>
  readings.map((reading, at) => ({ itemId: `item-${at + 1}`, reading }));

describe('Triage', () => {
  describe('a filing re-reads the Panel only of the unfiled items close in meaning to what was filed since the last refresh, at most twenty', () => {
    it('the threshold sits between the cosines the cases below use', () => {
      expect(Math.cos((40 * Math.PI) / 180)).toBeGreaterThan(COULD_BE_CHANGED_BY_A_FILING);
      expect(Math.cos((80 * Math.PI) / 180)).toBeLessThan(COULD_BE_CHANGED_BY_A_FILING);
    });

    it('an item at or inside the threshold is re-read, and one further from every filing is left with its proposal', () => {
      // 62 degrees is a cosine of 0.469, 64 degrees 0.438: either side of 0.45.
      expect(itemsToReadAgain(items(meaning(62), meaning(64), FAR), [FILED])).toEqual(['item-1']);
    });

    it('several filings since the last refresh are weighed together: an item close to only one is re-read', () => {
      const elsewhere = meaning(170);

      expect(itemsToReadAgain(items(CLOSE, FAR), [elsewhere, FILED])).toEqual(['item-1']);
    });

    it('an item with no meaning read yet is re-read', () => {
      expect(itemsToReadAgain(items(FAR, null, []), [FILED])).toEqual(['item-2', 'item-3']);
    });

    it('a filed note with no meaning read yet puts every item up for re-reading', () => {
      expect(itemsToReadAgain(items(FAR, CLOSE), [FILED, null])).toEqual(['item-1', 'item-2']);
    });

    it('no record of a previous refresh puts every item up for re-reading', () => {
      expect(itemsToReadAgain(items(FAR, CLOSE), null)).toEqual(['item-1', 'item-2']);
    });

    it('a filing that cannot be found since the last refresh puts every item up for re-reading', () => {
      // A filing's time is the device's, so one made on a clock running behind,
      // or replayed after reconnecting, can predate the last refresh.
      expect(itemsToReadAgain(items(FAR, CLOSE), [])).toEqual(['item-1', 'item-2']);
    });

    it.each([
      { situation: 'close in meaning to the filing', reading: CLOSE, filings: [FILED] },
      { situation: 'with no previous refresh on record', reading: FAR, filings: null },
    ])('more than twenty $situation are cut to the twenty most recently captured', ({ reading, filings }) => {
      const many = items(...Array.from({ length: 25 }, () => reading));

      const chosen = itemsToReadAgain(many, filings);

      expect(chosen).toHaveLength(20);
      expect(chosen).toEqual(many.slice(0, 20).map((item) => item.itemId));
    });
  });
});
