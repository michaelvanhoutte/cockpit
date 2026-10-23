import { describe, expect, it } from 'vitest';
import type { Layout, LayoutCell, LayoutRow, Panel } from '../../../src/domain/panel.js';
import { drawnRows } from '../../../src/domain/arrangement.js';

/**
 * L1: which Panels a Dashboard draws and in what order is a decision over a
 * list and a number, answered by the browser and by the Worker alike. How a
 * Panel is moved, sized or stacked on a phone is
 * apps/web/tests/unit/panels/arrangement.test.ts.
 */

function aLayout(id: string, rows: LayoutRow[] = []): Layout {
  return { id, tenantId: 'tenant', dashboardId: 'today', rows };
}

function cell(panelId: string, span: number): LayoutCell {
  return { panelId, span };
}

function aRow(cells: LayoutCell[], height: number | null = null): LayoutRow {
  return { height, cells };
}

function aPanel(id: string): Panel {
  return { id, tenantId: 'tenant', dashboardId: 'today', name: id, kind: 'items' as const, format: 'plain' as const, body: '', readOnly: false, neverPropose: false, filter: null, sort: null, columns: null };
}

describe('Layouts', () => {
  describe('the dashboard draws every panel it has, and only the panels it has', () => {
    it('draws the layout’s own rows when they hold every panel', () => {
      const layout = aLayout('laptop', [
        aRow([cell('falcon', 8), cell('anna', 4)], 300),
        aRow([cell('reading', 12)]),
      ]);

      expect(drawnRows(layout, [aPanel('falcon'), aPanel('anna'), aPanel('reading')], 1280)).toEqual([
        { height: 300, cells: [cell('falcon', 8), cell('anna', 4)] },
        { height: null, cells: [cell('reading', 12)] },
      ]);
    });

    it('gives a panel the layout has never heard of a row of its own', () => {
      // A panel added in another tab, against a layout saved before it existed.
      // Dropping it would hide something a person made; putting it beside
      // something would be a decision nobody took.
      const layout = aLayout('phone', [aRow([cell('a', 12)])]);

      expect(drawnRows(layout, [aPanel('a'), aPanel('new')], 480)).toEqual([
        { height: null, cells: [cell('a', 12)] },
        { height: null, cells: [cell('new', 12)] },
      ]);
    });

    it('leaves out a panel the layout still names but nothing has any more', () => {
      const layout = aLayout('laptop', [aRow([cell('a', 6), cell('gone', 6)])]);

      expect(drawnRows(layout, [aPanel('a')], 1280)).toEqual([
        { height: null, cells: [cell('a', 6)] },
      ]);
    });

    it('drops a row whose last panel is gone, rather than drawing a blank line', () => {
      const layout = aLayout('laptop', [
        aRow([cell('a', 12)]),
        aRow([cell('gone', 12)], 300),
        aRow([cell('b', 12)]),
      ]);

      expect(drawnRows(layout, [aPanel('a'), aPanel('b')], 1280)).toEqual([
        { height: null, cells: [cell('a', 12)] },
        { height: null, cells: [cell('b', 12)] },
      ]);
    });

    it.each([
      {
        situation: 'a laptop, three across',
        screenWidth: 1280,
        panels: ['a', 'b', 'c', 'd'],
        rows: [['a', 'b', 'c'], ['d']],
      },
      {
        situation: 'a screen wider than a laptop, four across',
        screenWidth: 2560,
        panels: ['a', 'b', 'c', 'd', 'e'],
        rows: [['a', 'b', 'c', 'd'], ['e']],
      },
      { situation: 'a phone, one across', screenWidth: 480, panels: ['a', 'b'], rows: [['a'], ['b']] },
      { situation: 'a dashboard with nothing on it', screenWidth: 1280, panels: [], rows: [] },
    ])('arranges a dashboard with no layout for the screen it is on: $situation', ({
      screenWidth,
      panels,
      rows,
    }) => {
      // The one place the old wrapping rule survives, and it belongs there:
      // before anybody has arranged a dashboard, how many fit at a size worth
      // reading is the only answer available.
      expect(drawnRows(null, panels.map(aPanel), screenWidth)).toEqual(
        rows.map((row) => ({ height: null, cells: row.map((id) => cell(id, 12)) })),
      );
    });
  });
});
