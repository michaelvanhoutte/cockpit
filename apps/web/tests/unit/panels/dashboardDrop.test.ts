import { describe, expect, it } from 'vitest';
import { dashboardTabAt } from '../../../src/panels/dashboardDrop';

/**
 * F1: which dashboard a drop lands on is a pure decision over the tabs'
 * measured rectangles and the point the pointer let go at. That the panel
 * actually moves there, the same way the picker's own choice does, is proved
 * in tests/unit/components/PanelBoard.test.tsx.
 */

function aTab(
  dashboardId: string,
  left: number,
  right: number,
): { dashboardId: string; left: number; right: number; top: number; bottom: number } {
  return { dashboardId, left, right, top: 0, bottom: 30 };
}

describe('Panels', () => {
  describe('where a panel let go lands among the dashboard tabs', () => {
    it('names the tab the point is inside of', () => {
      const tabs = [aTab('today', 0, 60), aTab('research', 60, 120)];

      expect(dashboardTabAt({ x: 90, y: 15 }, tabs, 'today')).toBe('research');
    });

    it('is nowhere when the point is outside every tab', () => {
      const tabs = [aTab('today', 0, 60), aTab('research', 60, 120)];

      expect(dashboardTabAt({ x: 90, y: 500 }, tabs, 'today')).toBeNull();
    });

    it('is nowhere when the tab under the point is the one already open', () => {
      // A drop that lands where the drag started changes nothing, and reading
      // it as a move to the dashboard already open would be a move that does
      // nothing but re-arranges the board it never left.
      const tabs = [aTab('today', 0, 60), aTab('research', 60, 120)];

      expect(dashboardTabAt({ x: 30, y: 15 }, tabs, 'today')).toBeNull();
    });

    it('is nowhere with no tabs on the page at all', () => {
      expect(dashboardTabAt({ x: 30, y: 15 }, [], 'today')).toBeNull();
    });

    it('gives the seam between two flush tabs to the one on its right, not both', () => {
      // The right and bottom edges are exclusive, so two tabs with no gap
      // between them never both match the pixel column where one ends and
      // the next begins.
      const tabs = [aTab('today', 0, 60), aTab('research', 60, 120)];

      expect(dashboardTabAt({ x: 60, y: 15 }, tabs, 'today')).toBe('research');
    });
  });
});
