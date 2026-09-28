import { describe, expect, it } from 'vitest';
import {
  BAND_PX,
  MAX_SPEED_PX_PER_SEC,
  MIN_SPEED_PX_PER_SEC,
  boxToScroll,
  scrollSpeed,
  scrollStep,
  scrollsForADragOf,
} from '../../src/dragScroll';
import { AGENT_BEING_DRAGGED } from '../../src/agentInTheAir';
import { ITEM_BEING_DRAGGED } from '../../src/dropAt';
import type { ScrollBox } from '../../src/dragScroll';

/**
 * F1, and this is where the rules live rather than in the loop that applies
 * them: jsdom scrolls nothing, so a test driving drag events against it would
 * measure nothing. That a drag really reaches what was off screen is
 * tests/e2e/filing.test.ts.
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
      expect(scrollSpeed(900, box())).toBe(MAX_SPEED_PX_PER_SEC);
      expect(scrollSpeed(100, box())).toBe(-MAX_SPEED_PX_PER_SEC);
    });

    it('goes at the minimum where the band starts', () => {
      expect(scrollSpeed(900 - BAND_PX + 1, box())).toBeCloseTo(MIN_SPEED_PX_PER_SEC, 0);
    });

    it('eases in, so halfway into the band is well under halfway from the minimum to the maximum', () => {
      const halfway = scrollSpeed(900 - BAND_PX / 2, box());
      const quarterOfTheWay = MIN_SPEED_PX_PER_SEC + (MAX_SPEED_PX_PER_SEC - MIN_SPEED_PX_PER_SEC) / 4;
      expect(halfway).toBeCloseTo(quarterOfTheWay, 0);
    });
  });

  describe('the speed is per second, not per frame', () => {
    it('covers the same distance at 60Hz and at 120Hz over the same second', () => {
      const distanceOver = (frameMs: number) => {
        let carry = 0;
        let total = 0;
        for (let frame = 0; frame < Math.round(1000 / frameMs); frame++) {
          const step = scrollStep(MAX_SPEED_PX_PER_SEC, frameMs, carry);
          carry = step.carry;
          total += step.pixels;
        }
        return total;
      };
      expect(Math.abs(distanceOver(1000 / 60) - distanceOver(1000 / 120))).toBeLessThanOrEqual(1);
    });

    it('caps a frame after a long pause instead of jumping', () => {
      const { pixels } = scrollStep(MAX_SPEED_PX_PER_SEC, 5000, 0);
      expect(pixels).toBeLessThan(MAX_SPEED_PX_PER_SEC);
    });

    it('carries a step under a pixel over to the next frame, so a slow scroll still moves', () => {
      const speed = 40; // 0.67px at a 60Hz frame - under a pixel on its own
      const frameMs = 1000 / 60;
      const first = scrollStep(speed, frameMs, 0);
      expect(first.pixels).toBe(0);
      const second = scrollStep(speed, frameMs, first.carry);
      expect(second.pixels).toBeGreaterThanOrEqual(1);
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

    it('scrolls the dashboard where nothing was scrolling and the list is already at its end', () => {
      const chosen = boxToScroll(
        { x: 500, y: 875 },
        [dashboard, list({ scrollTop: 1120 })],
        null,
        'item',
      );
      expect(chosen?.id).toBe('dashboard-0');
    });

    it('hands the scroll to the dashboard once the panel it was scrolling runs out of room', () => {
      const chosen = boxToScroll(
        { x: 500, y: 875 },
        [dashboard, list({ scrollTop: 1120 })],
        'panel-1',
        'item',
      );
      expect(chosen?.id).toBe('dashboard-0');
    });

    it('keeps scrolling the panel it was scrolling while it still has room', () => {
      const chosen = boxToScroll({ x: 500, y: 875 }, [dashboard, list()], 'panel-1', 'item');
      expect(chosen?.id).toBe('panel-1');
    });

    it('releases a held panel already at its start too, the same as at its end', () => {
      const chosen = boxToScroll(
        { x: 500, y: 520 },
        [dashboard, list({ scrollTop: 0 })],
        'panel-1',
        'item',
      );
      expect(chosen).toBeNull();
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

describe('Agents', () => {
  describe('an agent dragged near an edge scrolls the dashboard as an item does', () => {
    it.each([
      { situation: 'an item', types: [ITEM_BEING_DRAGGED, 'text/plain'], scrolls: true },
      { situation: 'an agent off the dock', types: [AGENT_BEING_DRAGGED, 'text/plain'], scrolls: true },
      { situation: 'a file from the desktop', types: ['Files'], scrolls: false },
      { situation: 'text from another page', types: ['text/plain'], scrolls: false },
    ])('a drag of $situation', ({ types, scrolls }) => {
      expect(scrollsForADragOf(types)).toBe(scrolls);
    });
  });
});
