import { describe, expect, it } from 'vitest';
import { takeUnfolds, unfoldWhenDrawn } from '../../../src/boardFocus';

/**
 * L1: a parent made by Combine from a Dashboard ("Brainstorming: cards on the
 * whiteboard can't be nested, combined or moved between boxes", issue 1830) is
 * drawn unfolded to its children, but only once its card is there and only once.
 */
describe('Whiteboard', () => {
  describe('a parent made by Combine is drawn unfolded the first time its card is on the board', () => {
    it('waits for its card, unfolds it once, and leaves every other card folded', () => {
      unfoldWhenDrawn('new-parent');

      expect(takeUnfolds(new Set(['other']))).toEqual([]);
      expect(takeUnfolds(new Set(['other', 'new-parent']))).toEqual(['new-parent']);
      expect(takeUnfolds(new Set(['other', 'new-parent']))).toEqual([]);
    });
  });
});
