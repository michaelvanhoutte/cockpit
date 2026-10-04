import { describe, expect, it } from 'vitest';
import { anchored } from '../../../src/panels/anchoring';

/**
 * L1: where the grabbed header ends up is arithmetic over four measurements.
 * That the page lays out the way these numbers say is the browser walk's
 * (tests/e2e/panels.test.ts).
 */
describe('Panels', () => {
  describe('the header grabbed stays under the pointer as the board collapses, and the one dropped as it opens', () => {
    it.each([
      {
        situation: 'grabbed low on a board still taller than the screen once collapsed',
        // The header was at 600 and is at 200 now; the Dashboard can still scroll 1000.
        measured: { wanted: 600, now: 200, scrollTop: 900, maxScrollTop: 1000 },
        is: { scrollTop: 500, shift: 0 },
      },
      {
        situation: 'grabbed low on a board that fits the screen once collapsed',
        // Nothing left to scroll: the 300 it cannot scroll becomes room above.
        measured: { wanted: 600, now: 200, scrollTop: 0, maxScrollTop: 0 },
        is: { scrollTop: 0, shift: 400 },
      },
      {
        situation: 'grabbed low where the board can scroll only part of the way',
        measured: { wanted: 600, now: 200, scrollTop: 150, maxScrollTop: 400 },
        is: { scrollTop: 0, shift: 250 },
      },
      {
        situation: 'grabbed in the first row, the gap above it opening',
        // The header is 18 lower than it was and there is no scroll to take it back up.
        measured: { wanted: 40, now: 58, scrollTop: 0, maxScrollTop: 0 },
        is: { scrollTop: 0, shift: -18 },
      },
      {
        situation: 'grabbed on a board already at the top of its scroll',
        measured: { wanted: 300, now: 120, scrollTop: 0, maxScrollTop: 0 },
        is: { scrollTop: 0, shift: 180 },
      },
      {
        situation: 'opening, the Dashboard able to scroll down to where the header should be',
        measured: { wanted: 300, now: 480, scrollTop: 0, maxScrollTop: 2000 },
        is: { scrollTop: 180, shift: 0 },
      },
    ])('$situation', ({ measured, is }) => {
      expect(anchored(measured)).toEqual(is);
    });
  });
});
