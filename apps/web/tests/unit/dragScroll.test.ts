import { describe, expect, it } from 'vitest';
import { BAND_PX, MAX_SPEED_PX, boxToScroll, scrollSpeed } from '../../src/dragScroll';
import type { ScrollBox } from '../../src/dragScroll';

/**
 * F1, and this is where the rules live rather than in the loop that applies
 * them: jsdom scrolls nothing, so a test driving drag events against it would
 * measure nothing. That a drag really reaches what was off screen is
 * tests/e2e/panels.test.ts.
 */

const box = (over: Partial<ScrollBox> = {}): ScrollBox => ({
  id: 'dashboard-0',
  kind: 'dashboard',
  left: 300,
  right: 1200,
  top: 100,
  bottom: 900,
  scrollTop: 200,
  scrollHeight: 2000,
  clientHeight: 800,
  ...over,
});

describe('Panels', () => {
  describe('how near an edge a drag is decides how fast that box scrolls', () => {
    it.each([
      { situation: 'well inside the box', y: 500, box: box(), goes: 'not at all' },
      { situation: 'within the band at the bottom', y: 900 - BAND_PX / 2, box: box(), goes: 'down' },
      { situation: 'within the band at the top', y: 100 + BAND_PX / 2, box: box(), goes: 'up' },
      { situation: 'past the top edge, over the bar', y: 60, box: box(), goes: 'not at all' },
      { situation: 'past the bottom edge', y: 950, box: box(), goes: 'not at all' },
      {
        situation: 'a box already at its end',
        y: 890,
        box: box({ scrollTop: 1200 }),
        goes: 'not at all',
      },
      {
        situation: 'a box already at its start',
        y: 110,
        box: box({ scrollTop: 0 }),
        goes: 'not at all',
      },
      {
        situation: 'a box with nothing to scroll',
        y: 890,
        box: box({ scrollTop: 0, scrollHeight: 800 }),
        goes: 'not at all',
      },
    ])('$situation → $goes', ({ y, box: b, goes }) => {
      const speed = scrollSpeed(y, b);
      if (goes === 'down') expect(speed).toBeGreaterThan(0);
      else if (goes === 'up') expect(speed).toBeLessThan(0);
      else expect(speed).toBe(0);
    });

    it('goes faster the nearer the edge', () => {
      expect(scrollSpeed(895, box())).toBeGreaterThan(scrollSpeed(870, box()));
    });

    it('goes as fast as it goes at the edge itself', () => {
      expect(scrollSpeed(900, box())).toBe(MAX_SPEED_PX);
      expect(scrollSpeed(100, box())).toBe(-MAX_SPEED_PX);
    });
  });

  describe('one box scrolls at a time, and keeps scrolling until the pointer leaves its edge', () => {
    const dashboard = box();
    const list = (over: Partial<ScrollBox> = {}) =>
      box({
        id: 'panel-1',
        kind: 'panel',
        left: 320,
        right: 700,
        top: 500,
        bottom: 880,
        scrollTop: 0,
        scrollHeight: 1500,
        clientHeight: 380,
        ...over,
      });
    const inTheDashboardsBand = { x: 1000, y: 895 };

    it('scrolls the dashboard where the pointer is in its bottom band', () => {
      expect(boxToScroll(inTheDashboardsBand, [dashboard, list()], null, 'item')?.id).toBe(
        'dashboard-0',
      );
    });

    it('keeps the dashboard when a panel list’s bottom edge slides under the pointer', () => {
      const chosen = boxToScroll({ x: 500, y: 875 }, [dashboard, list()], 'dashboard-0', 'item');
      expect(chosen?.id).toBe('dashboard-0');
    });

    it('scrolls a panel list where nothing was scrolling and the pointer is in its band', () => {
      const chosen = boxToScroll({ x: 500, y: 875 }, [box({ bottom: 1300 }), list()], null, 'item');
      expect(chosen?.id).toBe('panel-1');
    });

    it('scrolls the dashboard where the list is already at its end', () => {
      const chosen = boxToScroll(
        { x: 500, y: 890 },
        [dashboard, list({ scrollTop: 1120 })],
        null,
        'item',
      );
      expect(chosen?.id).toBe('dashboard-0');
    });

    it('scrolls nothing once the pointer leaves the scrolling box’s band', () => {
      expect(boxToScroll({ x: 1000, y: 500 }, [dashboard, list()], 'dashboard-0', 'item')).toBeNull();
    });

    it('scrolls nothing at the Inbox column’s edge, which is no box', () => {
      expect(boxToScroll({ x: 100, y: 895 }, [dashboard], null, 'item')).toBeNull();
    });

    it('scrolls only the dashboard during a panel drag', () => {
      const chosen = boxToScroll({ x: 500, y: 875 }, [box({ bottom: 1300 }), list()], null, 'panel');
      expect(chosen).toBeNull();
      expect(boxToScroll({ x: 500, y: 875 }, [dashboard, list()], null, 'panel')?.id).toBe(
        'dashboard-0',
      );
    });
  });
});
