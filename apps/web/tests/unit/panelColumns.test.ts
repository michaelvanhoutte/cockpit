import { describe, expect, it } from 'vitest';
import { PANEL_COLUMN_WIDTHS } from '@cockpit/shared';
import { columnsStyle, columnsThatFit, landingAmongColumns, type RowBox } from '../../src/panelColumns';

/**
 * F1, and pure, for the reason tests/unit/dropAt.test.ts is: jsdom lays
 * nothing out, so the count of columns and the place a dropped row lands are
 * proved here as arithmetic over a width and over rows' boxes. That the grid
 * draws the count promised, and that a row dragged between columns lands where
 * it was dropped, is tests/e2e/panels.test.ts.
 */

describe('Panels', () => {
  describe('the number of columns is as many of the minimum width, with their gaps, as the Panel holds', () => {
    it.each([
      { situation: '1532 wide at Wide', width: 1532, minimum: PANEL_COLUMN_WIDTHS.wide, columns: 2 },
      { situation: '1532 wide at Medium', width: 1532, minimum: PANEL_COLUMN_WIDTHS.medium, columns: 3 },
      { situation: '1532 wide at Narrow', width: 1532, minimum: PANEL_COLUMN_WIDTHS.narrow, columns: 4 },
      { situation: 'exactly two Medium columns and the gap between them', width: 864, minimum: 420, columns: 2 },
      { situation: 'one pixel less than that', width: 863, minimum: 420, columns: 1 },
      { situation: 'a phone at Narrow', width: 375, minimum: PANEL_COLUMN_WIDTHS.narrow, columns: 1 },
      { situation: 'a Panel narrower than one column', width: 200, minimum: PANEL_COLUMN_WIDTHS.wide, columns: 1 },
      { situation: 'a Panel with no width yet', width: 0, minimum: PANEL_COLUMN_WIDTHS.medium, columns: 1 },
    ])('$situation', ({ width, minimum, columns }) => {
      expect(columnsThatFit(width, minimum)).toBe(columns);
    });
  });

  describe('a Panel is drawn on a grid of the width chosen, or on none for one list', () => {
    it('lays the rows out in columns of at least the chosen width, 24 pixels apart', () => {
      expect(columnsStyle('medium')).toEqual({
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 420px), 1fr))',
        columnGap: 24,
      });
    });

    it('lays nothing out for one list', () => {
      expect(columnsStyle(null)).toBeUndefined();
    });
  });

  describe('a dragged row lands before or after the row under the pointer, by which half it is over', () => {
    /**
     * Two lines of three rows, each 400 wide and 40 tall, with a 24 gap between
     * columns and 8 between lines; and a last line of one row, on its own.
     */
    const row = (column: number, line: number): RowBox => ({
      left: column * 424,
      top: line * 48,
      width: 400,
      height: 40,
    });
    const rows = [row(0, 0), row(1, 0), row(2, 0), row(0, 1), row(1, 1), row(2, 1), row(0, 2)];

    it.each([
      { situation: 'the left half of the second row', x: 424 + 50, y: 20, lands: 1 },
      { situation: 'the right half of the second row', x: 424 + 350, y: 20, lands: 2 },
      { situation: 'the right half of the last row', x: 350, y: 2 * 48 + 20, lands: 7 },
      { situation: 'the gap between two columns, before the next row along', x: 412, y: 20, lands: 1 },
      { situation: 'past the end of a short line, after its last row', x: 900, y: 2 * 48 + 20, lands: 7 },
      { situation: 'the gap between two lines, by height, at the start of the line below', x: 450, y: 44, lands: 3 },
      { situation: 'above every row', x: 450, y: -30, lands: 0 },
      { situation: 'below every row', x: 450, y: 700, lands: 7 },
    ])('$situation', ({ x, y, lands }) => {
      expect(landingAmongColumns(rows, x, y)).toBe(lands);
    });

    it('lands at the only place there is in an empty list', () => {
      expect(landingAmongColumns([], 10, 10)).toBe(0);
    });
  });
});
