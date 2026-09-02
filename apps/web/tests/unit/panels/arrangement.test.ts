import { describe, expect, it } from 'vitest';
import type { Layout, Panel, PanelPlacement } from '@cockpit/shared';
import {
  drawnArrangement,
  fittedToScreen,
  layoutToDraw,
  madeForThisScreen,
  movedBefore,
  movedBy,
  panelsAcross,
  resizedTo,
  sameArrangement,
} from '../../../src/panels/arrangement';

/**
 * F1: which layout a dashboard is drawn with, and where its panels end up, are
 * decisions over a list and a number. That the result then really fits the
 * screen without scrolling sideways is a claim about layout that no arithmetic
 * can make, and it is proved in the browser by tests/e2e/panels.test.ts.
 */

function aLayout(id: string, screenWidth: number, placements: PanelPlacement[] = []): Layout {
  return { id, tenantId: 'tenant', dashboardId: 'today', screenWidth, placements };
}

function aPanel(id: string): Panel {
  return { id, tenantId: 'tenant', dashboardId: 'today', name: id };
}

function at(panelId: string, columns: number, rows: number): PanelPlacement {
  return { panelId, columns, rows };
}

describe('Panels', () => {
  describe('a dashboard is drawn with the layout closest to the screen it is on, or the one you chose', () => {
    const phone = aLayout('phone', 480);
    const laptop = aLayout('laptop', 1280);
    const wide = aLayout('wide', 2560);

    it.each([
      { situation: 'a phone', screenWidth: 480, chosen: null, drawn: 'phone' },
      { situation: 'a laptop', screenWidth: 1440, chosen: null, drawn: 'laptop' },
      { situation: 'a 4K screen', screenWidth: 2400, chosen: null, drawn: 'wide' },
      // Nothing was made at this width, and the nearest is what it gets rather
      // than nothing at all.
      { situation: 'a tablet nothing was made for', screenWidth: 900, chosen: null, drawn: 'laptop' },
      { situation: 'a screen where a layout was chosen by hand', screenWidth: 480, chosen: 'wide', drawn: 'wide' },
      // The issue's rule for a deleted layout, arriving by the only route it
      // can: the choice still names it and it is not in the list any more.
      { situation: 'a chosen layout that has since been deleted', screenWidth: 480, chosen: 'gone', drawn: 'phone' },
    ])('$situation', ({ screenWidth, chosen, drawn }) => {
      expect(layoutToDraw([phone, laptop, wide], 'today', screenWidth, chosen)?.id).toBe(drawn);
    });

    it('goes to the narrower one when two are equally close, so two screens agree', () => {
      expect(layoutToDraw([phone, laptop], 'today', 880, null)?.id).toBe('phone');
    });

    it('draws another dashboard’s layouts with nothing of this one', () => {
      const elsewhere = { ...aLayout('elsewhere', 1280), dashboardId: 'research' };

      expect(layoutToDraw([elsewhere], 'today', 1280, null)).toBeNull();
    });

    it.each([
      { situation: 'the same width', screenWidth: 1280, same: true },
      { situation: 'a scrollbar’s width away', screenWidth: 1265, same: true },
      { situation: 'a different screen', screenWidth: 480, same: false },
    ])('counts $situation as the screen it was made for: $same', ({ screenWidth, same }) => {
      expect(madeForThisScreen(laptop, screenWidth)).toBe(same);
    });
  });

  describe('rearranging for the screen keeps the order and fills the rows across it', () => {
    it.each([
      { situation: 'a phone', screenWidth: 480, across: 1, columns: 12 },
      { situation: 'a small laptop', screenWidth: 1024, across: 2, columns: 6 },
      { situation: 'a laptop', screenWidth: 1280, across: 3, columns: 4 },
      { situation: 'a 4K screen', screenWidth: 2560, across: 4, columns: 3 },
      // Narrower than one comfortable panel: one across is the floor, because
      // half a panel is not a panel.
      { situation: 'a screen narrower than one panel', screenWidth: 320, across: 1, columns: 12 },
    ])('puts $across across on $situation', ({ screenWidth, across, columns }) => {
      expect(panelsAcross(screenWidth)).toBe(across);

      const fitted = fittedToScreen([at('a', 1, 3), at('b', 12, 5)], screenWidth);

      // The order is kept - that is the issue's own wording - and only the
      // width moves: a panel somebody made tall stays tall.
      expect(fitted).toEqual([at('a', columns, 3), at('b', columns, 5)]);
    });
  });

  describe('the dashboard draws every panel it has, and only the panels it has', () => {
    it('draws the layout’s own arrangement when it holds every panel', () => {
      const layout = aLayout('laptop', 1280, [at('b', 8, 2), at('a', 4, 5)]);

      expect(drawnArrangement(layout, [aPanel('a'), aPanel('b')], 1280)).toEqual([
        at('b', 8, 2),
        at('a', 4, 5),
      ]);
    });

    it('appends a panel the layout has never heard of, at the size of what is last', () => {
      // A panel added in another tab, against a layout saved before it existed.
      // Dropping it would hide something a person made.
      const layout = aLayout('phone', 480, [at('a', 12, 4)]);

      expect(drawnArrangement(layout, [aPanel('a'), aPanel('new')], 480)).toEqual([
        at('a', 12, 4),
        at('new', 12, 4),
      ]);
    });

    it('leaves out a panel the layout still names but nothing has any more', () => {
      const layout = aLayout('laptop', 1280, [at('a', 4, 3), at('gone', 4, 3)]);

      expect(drawnArrangement(layout, [aPanel('a')], 1280)).toEqual([at('a', 4, 3)]);
    });

    it('clamps a stored place the grid could not draw, rather than refusing to draw at all', () => {
      const layout = aLayout('laptop', 1280, [at('a', 99, 0), at('b', -3, 4.6)]);

      expect(drawnArrangement(layout, [aPanel('a'), aPanel('b')], 1280)).toEqual([
        at('a', 12, 1),
        at('b', 1, 5),
      ]);
    });

    it.each([
      { situation: 'a dashboard with no layout at all', panels: ['a', 'b'], drawn: [at('a', 4, 3), at('b', 4, 3)] },
      { situation: 'a dashboard with nothing on it', panels: [], drawn: [] },
    ])('$situation is arranged for the screen it is on', ({ panels, drawn }) => {
      // The same arrangement "Fit to this screen" would give, deliberately:
      // pressing it on a fresh dashboard should not appear to do nothing.
      expect(drawnArrangement(null, panels.map(aPanel), 1280)).toEqual(drawn);
    });
  });

  describe('moving a panel puts it one place along, or where it was dropped', () => {
    const three = [at('a', 4, 3), at('b', 4, 3), at('c', 4, 3)];

    it.each([
      { situation: 'one place earlier', panelId: 'b', places: -1, order: ['b', 'a', 'c'] },
      { situation: 'one place later', panelId: 'b', places: 1, order: ['a', 'c', 'b'] },
      { situation: 'earlier from the front', panelId: 'a', places: -1, order: ['a', 'b', 'c'] },
      { situation: 'later from the back', panelId: 'c', places: 1, order: ['a', 'b', 'c'] },
      { situation: 'a panel that is not there', panelId: 'z', places: -1, order: ['a', 'b', 'c'] },
    ])('$situation', ({ panelId, places, order }) => {
      expect(movedBy(three, panelId, places).map((p) => p.panelId)).toEqual(order);
    });

    it.each([
      { situation: 'onto one behind it', panelId: 'a', onto: 'c', order: ['b', 'a', 'c'] },
      { situation: 'onto one in front of it', panelId: 'c', onto: 'a', order: ['c', 'a', 'b'] },
      { situation: 'onto itself', panelId: 'b', onto: 'b', order: ['a', 'b', 'c'] },
      { situation: 'onto one that is not there', panelId: 'b', onto: 'z', order: ['a', 'b', 'c'] },
    ])('dropped $situation', ({ panelId, onto, order }) => {
      // Dragging left to right is the case that lands one place short if the
      // target's index is read before the panel is taken out of the list.
      expect(movedBefore(three, panelId, onto).map((p) => p.panelId)).toEqual(order);
    });
  });

  describe('resizing a panel stops at the edges of the grid rather than refusing', () => {
    it.each([
      { situation: 'wider', size: { columns: 5 }, ends: at('a', 5, 3) },
      { situation: 'wider than the grid', size: { columns: 30 }, ends: at('a', 12, 3) },
      { situation: 'narrower than one column', size: { columns: 0 }, ends: at('a', 1, 3) },
      { situation: 'taller than any screen', size: { rows: 40 }, ends: at('a', 4, 8) },
      { situation: 'shorter than one row', size: { rows: -2 }, ends: at('a', 4, 1) },
    ])('$situation', ({ size, ends }) => {
      expect(resizedTo([at('a', 4, 3), at('b', 4, 3)], 'a', size)).toEqual([ends, at('b', 4, 3)]);
    });
  });

  describe('an arrangement that says the same thing as the one on screen is not a change', () => {
    it.each([
      { situation: 'nothing moved', other: [at('a', 4, 3), at('b', 4, 3)], same: true },
      { situation: 'one panel is wider', other: [at('a', 5, 3), at('b', 4, 3)], same: false },
      { situation: 'two panels swapped', other: [at('b', 4, 3), at('a', 4, 3)], same: false },
      { situation: 'a panel was added', other: [at('a', 4, 3), at('b', 4, 3), at('c', 4, 3)], same: false },
    ])('$situation', ({ other, same }) => {
      expect(sameArrangement([at('a', 4, 3), at('b', 4, 3)], other)).toBe(same);
    });
  });
});
