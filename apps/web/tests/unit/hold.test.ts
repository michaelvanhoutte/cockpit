import { describe, expect, it } from 'vitest';
import { HOLD_DRIFT_PX, stillHolding } from '../../src/hold';
import { SWIPE_THRESHOLD_PX } from '../../src/swipe';

/**
 * F1: what counts as holding a row still, decided away from any finger.
 *
 * That a row held this long is picked out is ItemRow's wiring, and that a thumb
 * can do it at all is tests/e2e/selecting.test.ts's.
 */

describe('Selection', () => {
  describe('a finger that stays put is holding, and one that goes anywhere is not', () => {
    it.each([
      { situation: 'not moved at all', dx: 0, dy: 0, holding: true },
      { situation: 'the wobble of a resting thumb', dx: 3, dy: 4, holding: true },
      { situation: 'drifted exactly as far as is allowed', dx: HOLD_DRIFT_PX, dy: 0, holding: true },
      { situation: 'set off across the row', dx: HOLD_DRIFT_PX + 1, dy: 0, holding: false },
      { situation: 'set off back the other way', dx: -(HOLD_DRIFT_PX + 1), dy: 0, holding: false },
      // Up and down disqualifies it as much as across: the list is scrolling,
      // and a row picked out by a scroll is worse than one that has to be held
      // again.
      { situation: 'set off down the list', dx: 0, dy: HOLD_DRIFT_PX + 1, holding: false },
      { situation: 'drifted a little each way, but far in the end', dx: 9, dy: 9, holding: false },
    ])('$situation', ({ dx, dy, holding }) => {
      expect(stillHolding(dx, dy)).toBe(holding);
    });
  });

  describe('a gesture cannot be both a hold and a swipe', () => {
    it('has stopped holding well before it has gone far enough to swipe', () => {
      // The two rules share one row, so the numbers have to leave no gesture
      // that satisfies both - which is a property of the pair, not of either.
      expect(HOLD_DRIFT_PX).toBeLessThan(SWIPE_THRESHOLD_PX);
      expect(stillHolding(SWIPE_THRESHOLD_PX, 0)).toBe(false);
    });
  });
});
