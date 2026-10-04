import { describe, expect, it } from 'vitest';
import { widestLayout } from '../../../src/domain/screen-size.js';
import type { ScreenSize } from '../../../src/domain/screen-size.js';

function aSize(id: string, width: number, createdAt = '2026-09-08T10:00:00.000Z'): ScreenSize {
  return { id, tenantId: 'tenant', name: id, width, createdAt };
}

function aLayout(id: string, screenSizeId: string, dashboardId = 'today') {
  return { id, dashboardId, screenSizeId };
}

describe('Dashboards', () => {
  describe('Layouts', () => {
    describe('a dashboard is drawn with its widest layout, ties to the earliest made then the lowest id, whichever way they are listed', () => {
      const sizes = [aSize('sz-laptop', 1646), aSize('sz-wide', 2560)];
      const layouts = [aLayout('laptop', 'sz-laptop'), aLayout('wide', 'sz-wide')];

      it.each([
        { situation: 'the wider one listed last', list: layouts },
        { situation: 'the wider one listed first', list: [...layouts].reverse() },
      ])('picks the 2560 px layout with $situation', ({ list }) => {
        expect(widestLayout(list, sizes, 'today')?.id).toBe('wide');
      });

      it.each([
        {
          situation: 'the earlier made wins at the same width',
          sizes: [aSize('b', 1280, '2026-09-01T00:00:00.000Z'), aSize('a', 1280, '2026-09-02T00:00:00.000Z')],
          winner: 'on-b',
        },
        {
          situation: 'the lowest id wins at the same width and moment',
          sizes: [aSize('b', 1280), aSize('a', 1280)],
          winner: 'on-a',
        },
      ])('$situation, in either listing order', ({ sizes: tied, winner }) => {
        const tiedLayouts = tied.map((size) => aLayout(`on-${size.id}`, size.id));
        expect(widestLayout(tiedLayouts, tied, 'today')?.id).toBe(winner);
        expect(widestLayout([...tiedLayouts].reverse(), [...tied].reverse(), 'today')?.id).toBe(winner);
      });

      it('draws the only layout even when it was made below 480 px', () => {
        expect(widestLayout([aLayout('only', 'sz-small')], [aSize('sz-small', 320)], 'today')?.id).toBe('only');
      });

      it.each([
        { situation: 'no layouts', list: [] },
        { situation: 'only another dashboard’s layouts', list: [aLayout('wide', 'sz-wide', 'research')] },
        { situation: 'a layout whose screen size is not in the list', list: [aLayout('lost', 'gone')] },
      ])('draws none for $situation', ({ list }) => {
        expect(widestLayout(list, sizes, 'today')).toBeNull();
      });
    });
  });
});
