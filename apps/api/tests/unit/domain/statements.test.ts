import { describe, expect, it } from 'vitest';
import { FILING_VALUES_PER_ROW } from '../../../src/domain/filings.js';
import { PLACEMENT_VALUES_PER_ROW } from '../../../src/domain/panels.js';
import { BOUND_VALUES_PER_STATEMENT, inBatchesOf } from '../../../src/domain/statements.js';

/**
 * L1: how a write too wide for one statement is divided is arithmetic over a
 * list. That the divided write really reaches the store, and really keeps the
 * order it was given, is proved against a real one in
 * tests/integration/http/panels.test.ts and panel-items.test.ts.
 */

const perRow = [
  { situation: 'a panel’s arrangement', valuesPerRow: PLACEMENT_VALUES_PER_ROW },
  { situation: 'a panel’s items', valuesPerRow: FILING_VALUES_PER_ROW },
];

describe('Panels', () => {
  describe('a list longer than one write can carry is written in several, whole and in order', () => {
    it.each(
      perRow.flatMap(({ situation, valuesPerRow }) =>
        [0, 1, 15, 16, 20, 21, 40, 199].map((rows) => ({
          situation: `${situation}, ${rows} of them`,
          valuesPerRow,
          rows,
        })),
      ),
    )('$situation', ({ valuesPerRow, rows }) => {
      const given = Array.from({ length: rows }, (_, n) => ({ n }));

      const written = inBatchesOf(given, valuesPerRow);

      // Every row exactly once and still in its place: what comes back out is
      // what went in, whether that took one write or ten.
      expect(written.flat()).toEqual(given);
      for (const batch of written) {
        expect(batch.length * valuesPerRow).toBeLessThanOrEqual(BOUND_VALUES_PER_STATEMENT);
        expect(batch.length).toBeGreaterThan(0);
      }
    });

    it('refuses a row too wide to be written at all, rather than looping forever', () => {
      // A guard on the arithmetic, not on a state the product can reach: a
      // batch size of zero would advance the loop by nothing.
      expect(() => inBatchesOf([{ n: 1 }], BOUND_VALUES_PER_STATEMENT + 1)).toThrow();
    });
  });
});
