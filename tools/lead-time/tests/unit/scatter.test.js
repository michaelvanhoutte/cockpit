import { describe, expect, it } from 'vitest';

import { layoutScatter, radiusFor } from '../../src/render/scatter.js';

const MIN = 60_000;
const dot = (number, coding, harness, rounds = 1) => ({ number, codingMs: coding * MIN, harnessMs: harness * MIN, rounds, ratio: coding ? harness / coding : null });

describe('Lead time', () => {
  describe('the scatter puts each pull request where its minutes are, and names the ones furthest above the line', () => {
    it('places a dot as a share of one scale that both axes use', () => {
      const layout = layoutScatter([dot(1, 15, 30), dot(2, 45, 10)], null);
      expect(layout.scaleMs).toBe(50 * MIN);
      expect(layout.dots.map((each) => [each.x, each.y])).toEqual([
        [0.3, 0.6],
        [0.9, 0.2],
      ]);
      expect(layout.dots.some((each) => each.off)).toBe(false);
    });

    it('fits the scale to the data up to two hours, and never to a scale of nothing', () => {
      expect(layoutScatter([dot(1, 90, 100)], null).scaleMs).toBe(120 * MIN);
      expect(layoutScatter([dot(1, 200, 100)], null).scaleMs).toBe(120 * MIN);
      expect(layoutScatter([], null).scaleMs).toBeGreaterThan(0);
      expect(layoutScatter([dot(1, 2, 3)], null).ticks.length).toBeGreaterThan(1);
    });

    it('puts a dot beyond the scale on the edge and marks it off the chart, leaving one that only reaches the edge alone', () => {
      const layout = layoutScatter([dot(1, 300, 20), dot(2, 10, 500), dot(3, 120, 30)], null);
      expect(layout.dots.map((each) => [each.number, each.x, each.y, each.off])).toEqual([
        [1, 1, 20 / 120, true],
        [2, 10 / 120, 1, true],
        [3, 1, 0.25, false],
      ]);
    });

    it('labels the three furthest above the equal line, and not one below it however far', () => {
      const layout = layoutScatter([dot(1, 10, 15), dot(2, 10, 60), dot(3, 20, 80), dot(4, 10, 40), dot(5, 100, 5), dot(6, 5, 20)], null);
      expect(layout.dots.filter((each) => each.labelled).map((each) => each.number)).toEqual([2, 3, 4]);
    });

    it('labels fewer where fewer are above the line', () => {
      const layout = layoutScatter([dot(1, 30, 10), dot(2, 10, 20)], null);
      expect(layout.dots.filter((each) => each.labelled).map((each) => each.number)).toEqual([2]);
    });

    it('draws the median line to the right edge where it is shallower than the diagonal, and to the top where steeper', () => {
      expect(layoutScatter([dot(1, 10, 5)], 0.5).median).toEqual({ x: 1, y: 0.5 });
      expect(layoutScatter([dot(1, 10, 20)], 4).median).toEqual({ x: 0.25, y: 1 });
      expect(layoutScatter([dot(1, 10, 20)], null).median).toBeNull();
    });

    it('draws a dot larger for more rounds, and never past a size that would cover its neighbours', () => {
      expect(radiusFor(1)).toBeGreaterThanOrEqual(4);
      expect(radiusFor(5)).toBeGreaterThan(radiusFor(1));
      expect(radiusFor(40)).toBe(radiusFor(20));
    });
  });
});
