import { describe, expect, it } from 'vitest';
import { SWIPE_THRESHOLD_PX, howFarItHasGone, whatTheSwipeMeant } from '../../src/swipe';

/**
 * F1, and this is where the rules live rather than in the handler that uses
 * them: jsdom produces no gesture at all, so a test driving synthetic pointer
 * events proves a handler is wired and nothing else - it cannot fail for any
 * reason a thumb would. That a finger can actually reach these is
 * tests/e2e/triage.test.ts, on the phone project.
 */

const past = SWIPE_THRESHOLD_PX + 10;
const short = SWIPE_THRESHOLD_PX - 10;

describe('Triage', () => {
  describe('a swipe decides by how far and in which direction it went', () => {
    it.each([
      { situation: 'far enough right', dx: past, dy: 0, meant: 'file' },
      { situation: 'far enough left', dx: -past, dy: 0, meant: 'dismiss' },
      { situation: 'right, but stopped short', dx: short, dy: 0, meant: null },
      { situation: 'left, but stopped short', dx: -short, dy: 0, meant: null },
      { situation: 'exactly the threshold', dx: SWIPE_THRESHOLD_PX, dy: 0, meant: 'file' },
      { situation: 'no movement at all', dx: 0, dy: 0, meant: null },
      {
        situation: 'far right, but further down',
        dx: past,
        dy: past + 1,
        meant: null,
      },
      {
        situation: 'far left, but further up',
        dx: -past,
        dy: -(past + 1),
        meant: null,
      },
      {
        // The list scrolling wins ties: a scroll that files something is far
        // worse than a swipe that has to be made again.
        situation: 'as far across as it went down',
        dx: past,
        dy: past,
        meant: null,
      },
      {
        situation: 'a long scroll that drifted a little sideways',
        dx: short,
        dy: 400,
        meant: null,
      },
    ])('$situation', ({ dx, dy, meant }) => {
      expect(whatTheSwipeMeant(dx, dy)).toBe(meant);
    });
  });

  describe('a row follows the finger sideways, and not a thumb that is scrolling', () => {
    it.each([
      { situation: 'moving right', dx: 40, dy: 5, drawn: 40 },
      { situation: 'moving left', dx: -40, dy: 5, drawn: -40 },
      { situation: 'moving mostly down', dx: 40, dy: 90, drawn: 0 },
      { situation: 'moving straight down', dx: 0, dy: 90, drawn: 0 },
    ])('$situation', ({ dx, dy, drawn }) => {
      expect(howFarItHasGone(dx, dy)).toBe(drawn);
    });
  });
});
