import { describe, expect, it } from 'vitest';
import { placeAfterMoving, placeAmongHeld, whereItWouldLand } from '../../src/dropAt';

/**
 * F1, and this is where the arithmetic lives rather than in the handler that
 * uses it: jsdom has no layout engine and reports every rectangle as zero, so a
 * test that drove a drag against it would be measuring nothing. What a browser
 * proves is that a person can aim at a gap at all
 * (tests/e2e/filing.test.ts); what is provable here is which gap a position
 * picks out, which is the part with the off-by-one in it.
 */

/** Four rows forty pixels tall, the first starting at 100. */
const fourRows = [120, 160, 200, 240];

describe('Panels', () => {
  describe('a dropped row lands in the gap the pointer is over', () => {
    it.each([
      { situation: 'above the first row', y: 105, gap: 0 },
      { situation: 'in the top half of the first row', y: 119, gap: 0 },
      { situation: 'in the bottom half of the first row', y: 121, gap: 1 },
      { situation: 'between the second and the third', y: 175, gap: 2 },
      { situation: 'in the bottom half of the last row', y: 245, gap: 4 },
      { situation: 'below every row', y: 900, gap: 4 },
      // The middle of a row is still that row: a pointer exactly on it has not
      // passed it, so it lands above rather than below.
      { situation: 'exactly on a row’s middle', y: 160, gap: 1 },
    ])('$situation', ({ y, gap }) => {
      expect(whereItWouldLand(fourRows, y)).toBe(gap);
    });

    it('lands in the only place there is when the list is empty', () => {
      expect(whereItWouldLand([], 500)).toBe(0);
    });
  });

  describe('a row already in the list lands where it was let go, not one short', () => {
    it.each([
      // Taking the row out of its old place shifts every gap below it up one.
      { situation: 'dragged down past one row', from: 0, gap: 2, place: 1 },
      { situation: 'dragged down to the end', from: 0, gap: 4, place: 3 },
      { situation: 'dragged up past one row', from: 3, gap: 1, place: 1 },
      { situation: 'dropped in the gap above itself', from: 2, gap: 2, place: 2 },
      { situation: 'dropped in the gap below itself', from: 2, gap: 3, place: 2 },
      { situation: 'arriving from another list', from: null, gap: 3, place: 3 },
      { situation: 'arriving from another list, at the end', from: null, gap: 4, place: 4 },
    ])('$situation', ({ from, gap, place }) => {
      expect(placeAfterMoving(gap, from)).toBe(place);
    });
  });

  describe('a place among the rows a panel draws is a place in the order it holds', () => {
    // A panel holding a finished item draws fewer rows than it holds: the
    // filing outlives the item being finished, so the two lists differ.
    const held = ['finished', 'a', 'b'];
    const drawn = ['a', 'b'];

    it.each([
      { situation: 'above the first row it draws', place: 0, held: 1 },
      { situation: 'between the two rows it draws', place: 1, held: 2 },
      { situation: 'past the last row it draws', place: 2, held: 3 },
    ])('an arriving item $situation', ({ place, held: expected }) => {
      expect(placeAmongHeld(held, drawn, 'arriving', place)).toBe(expected);
    });

    it.each([
      // Above `a`, which is where the top of the *drawn* list is - not above
      // the finished row, which is not on the screen and which nobody moved
      // anything past.
      { situation: 'to the top', place: 0, held: 1 },
      { situation: 'to the end', place: 1, held: 2 },
    ])('a row already drawn, moved $situation', ({ place, held: expected }) => {
      // `b` is taken out of both lists before it is put back, so the places are
      // counted among what is left.
      expect(placeAmongHeld(held, drawn, 'b', place)).toBe(expected);
    });

    it('lands last when the panel draws nothing at all', () => {
      expect(placeAmongHeld(['finished'], [], 'arriving', 0)).toBe(1);
    });

    it('lands last rather than nowhere when the two lists have come apart', () => {
      expect(placeAmongHeld(['a'], ['a', 'a stranger'], 'arriving', 1)).toBe(1);
    });
  });
});
