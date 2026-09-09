import { describe, expect, it } from 'vitest';
import { isCutOff } from '../../src/cutOff';

/**
 * F1: what counts as text showing less than it holds, decided away from any
 * layout engine - which is why the rule takes two widths rather than reading
 * them off an element, jsdom having none.
 *
 * That hovering a cut label spells it out is ItemRow's wiring, and that the
 * browser really does cut a long title in a narrow column is
 * tests/e2e/inbox.test.ts's.
 */

describe('Triage', () => {
  describe('a row offers its full label only where it cannot draw all of it', () => {
    it.each([
      { situation: 'a title far wider than the column', scroll: 340, client: 120, cut: true },
      { situation: 'a title with room to spare', scroll: 96, client: 120, cut: false },
      { situation: 'a title that fills its line exactly', scroll: 120, client: 120, cut: false },
      // Both widths are whole pixels, so text that fits to within a fraction of
      // one still reports a pixel more than it has room for. Spelling out a
      // label you can already read in full is the noise this rule exists to
      // avoid, so a hair of rounding is not a cut.
      { situation: 'over by the rounding of a pixel', scroll: 121, client: 120, cut: false },
      { situation: 'over by enough to have lost a letter', scroll: 122, client: 120, cut: true },
      // A row drawn before it has been laid out, and every element in jsdom.
      // Nothing is on screen to be cut, so nothing is offered.
      { situation: 'not laid out at all', scroll: 0, client: 0, cut: false },
    ])('$situation', ({ scroll, client, cut }) => {
      expect(isCutOff(scroll, client)).toBe(cut);
    });
  });
});
