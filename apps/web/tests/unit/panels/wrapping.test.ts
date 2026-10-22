import { describe, expect, it } from 'vitest';
import {
  LEAST_PANEL_WIDTH,
  lastPanelSpan,
  linesOf,
  panelsPerLine,
  tracksOf,
  wrappedTracksOf,
} from '../../../src/panels/wrapping';

/**
 * F1, and pure, for the reason tests/unit/panelColumns.test.ts is: jsdom lays
 * nothing out, so how many Panels a row puts side by side, what the last one
 * spans and what a row that does not wrap asks of its tracks are arithmetic
 * over a width and a count. That the grid draws them, and that nothing scrolls
 * sideways at any width, is tests/e2e/panels.test.ts.
 */

/** The four pixels between two Panels (`PANEL_GAP`, whether a divider or not). */
const GAP = 4;
const THREE_PANELS_AND_THEIR_GAPS = 3 * LEAST_PANEL_WIDTH + 2 * GAP;

describe('Panels', () => {
  describe('a row puts as many of its Panels side by side as can each have 240 px, and wraps the rest one at a time, in order, with the last Panel spanning what is left of its line', () => {
    it.each([
      { situation: 'three Panels, room for three', panels: 3, width: 1000, across: 3, span: 1 },
      { situation: 'three Panels, room for two', panels: 3, width: 600, across: 2, span: 2 },
      { situation: 'three Panels, room for one', panels: 3, width: 400, across: 1, span: 1 },
      { situation: 'four Panels, room for three', panels: 4, width: 800, across: 3, span: 3 },
      { situation: 'four Panels, room for two', panels: 4, width: 600, across: 2, span: 1 },
      { situation: 'five Panels, room for three', panels: 5, width: 800, across: 3, span: 2 },
      { situation: 'one Panel, narrower than 240 px', panels: 1, width: 200, across: 1, span: 1 },
      { situation: 'three Panels, with room for more than three', panels: 3, width: 3000, across: 3, span: 1 },
      { situation: 'exactly three times 240 px plus the gaps', panels: 3, width: THREE_PANELS_AND_THEIR_GAPS, across: 3, span: 1 },
      { situation: 'one pixel less than that', panels: 3, width: THREE_PANELS_AND_THEIR_GAPS - 1, across: 2, span: 2 },
      { situation: 'no width measured', panels: 3, width: null, across: 1, span: 1 },
      { situation: 'a width of nothing', panels: 3, width: 0, across: 1, span: 1 },
    ])('$situation', ({ panels, width, across, span }) => {
      const perLine = panelsPerLine(panels, width, GAP);

      expect(perLine).toBe(across);
      expect(lastPanelSpan(panels, perLine)).toBe(span);
    });

    it.each([
      { situation: 'three across', panels: 3, perLine: 3, lines: 1 },
      { situation: 'two across, the third under them', panels: 3, perLine: 2, lines: 2 },
      { situation: 'one across', panels: 3, perLine: 1, lines: 3 },
      { situation: 'two lines of two', panels: 4, perLine: 2, lines: 2 },
    ])('takes $lines line(s) for $situation', ({ panels, perLine, lines }) => {
      expect(linesOf(panels, perLine)).toBe(lines);
    });

    it('draws a wrapped line as equal columns', () => {
      expect(wrappedTracksOf(2)).toBe('repeat(2, minmax(0, 1fr))');
    });
  });

  describe('a row that does not wrap keeps the shares its dividers set, but draws no Panel under 240 px', () => {
    it.each([
      {
        situation: 'shares of 1 and 11 twelfths',
        shares: [1, 11],
        tracks: 'minmax(240px, 1fr) 4px minmax(240px, 11fr)',
      },
      {
        situation: 'even thirds',
        shares: [4, 4, 4],
        tracks: 'minmax(240px, 4fr) 4px minmax(240px, 4fr) 4px minmax(240px, 4fr)',
      },
      { situation: 'one Panel alone, which fits whatever the room', shares: [12], tracks: 'minmax(0, 12fr)' },
    ])('draws $situation, none under 240 px', ({ shares, tracks }) => {
      expect(tracksOf(shares, GAP)).toBe(tracks);
    });
  });
});
