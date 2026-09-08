import { describe, expect, it } from 'vitest';
import {
  SWIPE_THRESHOLD_PX,
  howFarItHasGone,
  whatTheSwipeIsPromising,
  whatTheSwipeMeant,
} from '../../src/swipe';

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

  describe('a row being swiped says what letting go would do, from the first pixel', () => {
    it.each([
      {
        situation: 'barely moved right',
        dx: 4,
        dy: 0,
        promised: { action: 'file', wouldAct: false },
      },
      {
        situation: 'barely moved left',
        dx: -4,
        dy: 0,
        promised: { action: 'dismiss', wouldAct: false },
      },
      {
        situation: 'right, and stopped short',
        dx: short,
        dy: 0,
        promised: { action: 'file', wouldAct: false },
      },
      {
        situation: 'left, and stopped short',
        dx: -short,
        dy: 0,
        promised: { action: 'dismiss', wouldAct: false },
      },
      {
        situation: 'right, far enough to act',
        dx: past,
        dy: 0,
        promised: { action: 'file', wouldAct: true },
      },
      {
        situation: 'left, far enough to act',
        dx: -past,
        dy: 0,
        promised: { action: 'dismiss', wouldAct: true },
      },
      {
        situation: 'exactly the threshold',
        dx: SWIPE_THRESHOLD_PX,
        dy: 0,
        promised: { action: 'file', wouldAct: true },
      },
      { situation: 'not moved at all', dx: 0, dy: 0, promised: null },
      // The row promises nothing to a thumb that is scrolling the list past
      // it, for the same reason it does not shuffle sideways under one.
      { situation: 'a long scroll that drifted a little sideways', dx: short, dy: 400, promised: null },
      { situation: 'as far across as it went down', dx: past, dy: past, promised: null },
    ])('$situation', ({ dx, dy, promised }) => {
      expect(whatTheSwipeIsPromising(dx, dy)).toEqual(promised);
    });
  });

  // The failure this guards is a row saying **Dismiss** under the thumb and
  // filing on release, which is the one this gesture can least afford. The two
  // answers come from one function, so this is what would go red if they were
  // ever decided apart again.
  describe('the action a row promises is the one letting go takes', () => {
    it.each([
      { situation: 'right, and stopped short', dx: short },
      { situation: 'left, and stopped short', dx: -short },
      { situation: 'right, far enough to act', dx: past },
      { situation: 'left, far enough to act', dx: -past },
      { situation: 'exactly the threshold', dx: SWIPE_THRESHOLD_PX },
      { situation: 'one pixel short of it', dx: SWIPE_THRESHOLD_PX - 1 },
      { situation: 'a scroll that drifted sideways', dx: short },
    ])('$situation', ({ dx }) => {
      const promised = whatTheSwipeIsPromising(dx, 0);
      expect(whatTheSwipeMeant(dx, 0)).toBe(promised?.wouldAct ? promised.action : null);
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
