import { describe, expect, it } from 'vitest';

import { layoutScatter, PLOT_SIZE, radiusFor } from '../../src/render/scatter.js';

const MIN = 60_000;
const dot = (number, coding, harness, rounds = 1, lines = 0) => ({ number, codingMs: coding * MIN, harnessMs: harness * MIN, rounds, lines, ratio: coding ? harness / coding : null });

describe('Cycle time', () => {
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
  });

  describe('a dot is as big as its pull request was, and as strong as its CI rounds were many', () => {
    const lineRadius = (lines, maxLines) => radiusFor(lines, maxLines);

    it('draws a dot from 4 to 14px by the square root of its lines over the window’s largest', () => {
      expect([
        lineRadius(1000, 1000),
        lineRadius(250, 1000),
        lineRadius(0, 1000),
        lineRadius(5000, 1000),
      ]).toEqual([14, 9, 4, 14]);
    });

    it('draws every dot at 4px where nothing in the window changed any lines, never failing on it', () => {
      expect(lineRadius(0, 0)).toBe(4);
      const layout = layoutScatter([dot(1, 10, 20, 1, 0), dot(2, 10, 30, 2, 0), { ...dot(3, 10, 40), lines: undefined }], null);
      expect(layout.maxLines).toBe(0);
      expect(layout.dots.map((each) => each.radius)).toEqual([4, 4, 4]);
    });

    it('sizes each dot against the largest in the window, and keys sample dots on that scale', () => {
      const layout = layoutScatter([dot(1, 10, 20, 1, 40), dot(2, 10, 30, 1, 160)], null);
      expect(layout.dots.map((each) => each.radius)).toEqual([9, 14]);
      expect(layout.sizeKey).toEqual([
        { lines: 40, radius: 9 },
        { lines: 160, radius: 14 },
      ]);
    });

    it('never keys a sample of no lines beside a window that changed some', () => {
      expect(layoutScatter([dot(1, 10, 20, 1, 2)], null).sizeKey.map((sample) => sample.lines)).toEqual([1, 2]);
      expect(layoutScatter([dot(1, 10, 20, 1, 1)], null).sizeKey.map((sample) => sample.lines)).toEqual([1]);
      expect(layoutScatter([dot(1, 10, 20, 1, 0)], null).sizeKey).toEqual([{ lines: 0, radius: 4 }]);
    });

    it('shades a dot by its CI rounds in five steps, the fifth for five or more', () => {
      const layout = layoutScatter([1, 2, 3, 4, 5, 6].map((rounds) => dot(rounds, 10, 20, rounds)), null);
      expect(layout.dots.map((each) => each.step)).toEqual([1, 2, 3, 4, 5, 5]);
    });
  });

  describe('the named dots’ labels never overlap and stay on the chart', () => {
    // A dot below the line, to hold the scale at two hours: 3.17px a minute.
    const onTwoHours = (...dots) => layoutScatter([...dots, dot(99, 120, 5)], null);
    const labelOf = (layout, number) => layout.dots.find((each) => each.number === number).label;
    const overlapping = (a, b) => a.box[0] < b.box[2] && b.box[0] < a.box[2] && a.box[1] < b.box[3] && b.box[1] < a.box[3];

    it('puts a label right of its dot where there is room', () => {
      expect(labelOf(onTwoHours(dot(1177, 30, 60)), 1177).slot).toBe('right');
    });

    it('puts a label left of its dot near the right edge, where the right would run off the plot', () => {
      expect(labelOf(onTwoHours(dot(1177, 115, 119)), 1177).slot).toBe('left');
    });

    it('puts a label below its dot where the right and left are taken by other labels', () => {
      // 1 and 2 are named before 3 (they are further above the line) and their labels stand to its right and its left.
      const layout = onTwoHours(dot(1111, 44.8, 103), dot(2222, 62.2, 103), dot(3333, 60, 100));
      expect(labelOf(layout, 1111).slot).toBe('right');
      expect(labelOf(layout, 2222).slot).toBe('right');
      expect(labelOf(layout, 3333).slot).toBe('below');
    });

    it('leaves a label off where no place is free, and still has the dot', () => {
      // The last is by the top-right corner: the right runs off the plot, the left is taken by the first and below it by the second.
      const layout = onTwoHours(dot(1111, 94.7, 125), dot(2222, 106.4, 112.1), dot(3333, 114, 116));
      expect(labelOf(layout, 1111)).not.toBeNull();
      expect(labelOf(layout, 2222)).not.toBeNull();
      const last = layout.dots.find((each) => each.number === 3333);
      expect(last.label).toBeNull();
      expect(last.labelled).toBe(true);
    });

    it('names the three furthest above the line on a two-hour scale without any two labels overlapping', () => {
      const layout = onTwoHours(dot(1177, 14, 304), dot(1172, 9, 269), dot(1180, 42, 198));
      const labels = [1177, 1172, 1180].map((number) => labelOf(layout, number));
      expect(labels.every(Boolean)).toBe(true);
      for (const [index, label] of labels.entries()) {
        for (const other of labels.slice(index + 1)) expect(overlapping(label, other)).toBe(false);
        // Sideways it may not leave the plot; up and down it may stand half a line outside it, as a dot on the edge has its label centred on it.
        expect(label.box[0]).toBeGreaterThanOrEqual(0);
        expect(label.box[2]).toBeLessThanOrEqual(PLOT_SIZE);
        expect(label.box[1]).toBeGreaterThanOrEqual(-7);
        expect(label.box[3]).toBeLessThanOrEqual(PLOT_SIZE + 7);
      }
    });
  });
});
