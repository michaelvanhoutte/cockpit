import { describe, expect, it } from 'vitest';
import { placeAmong } from '../../src/tabDrag';

/**
 * F1: where a dragged tab lands is arithmetic over the other tabs' rectangles,
 * so the rectangles are given here rather than measured - jsdom has no layout
 * to measure. That a person can drag a tab at all is proved in
 * tests/e2e/workspace-management.test.ts.
 *
 * The strip below is Workspace 1, a wide Anchor and a narrow Mover being
 * dragged leftwards, laid out twice: as it stands, and with Mover painted in
 * front of Anchor, which is the preview a drag shows once Mover has passed
 * Anchor's middle.
 */
const asItStands = [
  { left: 0, right: 100, ahead: false },
  { left: 104, right: 264, ahead: false },
];
const moverInFront = [
  { left: 0, right: 100, ahead: false },
  { left: 252, right: 412, ahead: false },
];

describe('Ordering', () => {
  describe('a tab dragged along the strip lands after every tab whose middle the pointer has passed', () => {
    it.each([
      { situation: 'short of the first tab’s middle', x: 40, lands: 0 },
      { situation: 'past the first tab’s middle, short of the next one’s', x: 60, lands: 1 },
      { situation: 'past a tab’s middle but short of its far edge', x: 200, lands: 2 },
      { situation: 'off the end of the strip', x: 900, lands: 2 },
    ])('$situation', ({ x, lands }) => {
      expect(placeAmong(asItStands, x)).toBe(lands);
    });

    it.each([
      { situation: 'a tab it travels towards on the right', ahead: true, lands: 1 },
      { situation: 'a tab it travels towards on the left', ahead: false, lands: 0 },
    ])('passes $situation once the pointer reaches its middle', ({ ahead, lands }) => {
      expect(placeAmong([{ left: 100, right: 200, ahead }], 150)).toBe(lands);
    });
  });

  describe('a narrow tab dragged in front of a wide one stays there while the pointer goes on', () => {
    it('keeps the place it was shown in through every move between the two paintings', () => {
      // Every point the pointer crosses from just inside Anchor's middle to the
      // left edge of the strip's second place. The preview is painted after
      // the first of them, so each later one is read off that painting.
      const [first, ...rest] = [182, 170, 160, 140, 120, 105];

      expect(placeAmong(asItStands, first!)).toBe(1);
      expect(rest.map((x) => placeAmong(moverInFront, x))).toEqual(rest.map(() => 1));
    });

    it('goes back behind it only once the pointer has passed the wide tab’s middle where it is now painted', () => {
      expect([255, 264, 331, 333].map((x) => placeAmong(moverInFront, x))).toEqual([1, 1, 1, 2]);
    });
  });
});
