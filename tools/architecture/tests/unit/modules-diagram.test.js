import { describe, expect, it } from 'vitest';

import { renderModules } from '../../src/render/modules.js';

const area = (path, name = path) => ({ path, name, description: `${name} does its job`, role: 'core', state: 'described', sources: [], breaches: [] });
const model = ({ lanes, cells = [], undecidedPairs = [] }) => {
  const layers = lanes.map((paths, index) => ({ title: `Lane ${index}`, note: '', areas: paths.map((each) => (typeof each === 'string' ? area(each) : each)) }));
  const paths = layers.flatMap((each) => each.areas.map((one) => one.path));
  return {
    modules: { layers },
    dependencies: { areas: paths.map((path) => ({ path, lines: 10 })), cells, undecidedPairs },
  };
};
const down = (from, to, files) => ({ from, to, files, kind: 'downward' });

/** Every box on the page with where it stands. */
const boxesOf = (svg) =>
  [...svg.matchAll(/<rect class="[a-z]+" data-area="([^"]*)" x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/g)].map((each) => ({ area: each[1], x: Number(each[2]), y: Number(each[3]), width: Number(each[4]), height: Number(each[5]) }));
const overlapping = (boxes) =>
  boxes.flatMap((a, at) => boxes.slice(at + 1).filter((b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height).map((b) => `${a.area} / ${b.area}`));
const labels = (svg) => [...svg.matchAll(/<text class="e-lbl( up)?" [^>]*>([^<]*)<\/text>/g)].map((each) => `${each[1] ? 'up ' : ''}${each[2]}`);

describe('Modules', () => {
  describe('a cycle draws its upward half red and its downward half as an ordinary arrow', () => {
    const cycle = (undecidedPairs) =>
      renderModules(model({ lanes: [['a', 'b']], cells: [{ from: 'a', to: 'b', files: 3, kind: 'partner' }, { from: 'b', to: 'a', files: 2, kind: 'upward' }], undecidedPairs }));

    it.each([
      { situation: 'unequal halves: one grey arrow down, one red arrow up with its files', undecidedPairs: [], expected: ['3', 'up 2'] },
      { situation: 'equal halves: the red arrow is labelled a tie', undecidedPairs: [['a', 'b']], expected: ['3', 'up 2 (tie)'] },
    ])('$situation', ({ undecidedPairs, expected }) => {
      const svg = cycle(undecidedPairs);
      expect(svg.match(/<line class="edge"/g)).toHaveLength(1);
      expect(svg.match(/<path class="edge-up"/g)).toHaveLength(1);
      expect(labels(svg)).toEqual(expected);
    });
  });

  describe('only the shortest chain of imports is drawn, each arrow labelled with its files', () => {
    it('leaves out an import a longer chain covers and labels the others', () => {
      const svg = renderModules(model({ lanes: [['a', 'b', 'c']], cells: [down('a', 'b', 4), down('b', 'c', 9), down('a', 'c', 2)] }));
      expect(svg.match(/<line class="edge"/g)).toHaveLength(2);
      expect(labels(svg).sort()).toEqual(['4', '9']);
    });
  });

  describe('no two boxes overlap, whatever the number of areas on a row', () => {
    it.each([
      { situation: 'a row of many areas in one lane', lanes: [Array.from({ length: 12 }, (_, at) => `area-${at}`)] },
      { situation: 'a new area with a long name, with and without spaces in it', lanes: [['one', 'two', { ...area('x'), name: 'a-very-long-area-name-with-no-room-to-spare-anywhere-at-all' }, { ...area('y'), name: 'a long area name that can wrap at its spaces instead' }]] },
      { situation: 'areas under one another in several lanes', lanes: [['a', 'b', 'c'], ['d', 'e'], ['f']], cells: [down('a', 'd', 1), down('d', 'f', 1), down('b', 'e', 1), down('e', 'f', 1)] },
      {
        situation: 'a box with marks to say',
        lanes: [['a', { ...area('b'), sources: [{ id: 'gmail', name: 'Gmail', files: ['one.ts', 'two.ts', 'three.ts', 'four.ts'] }] }, 'c']],
        cells: [down('a', 'b', 1)],
      },
    ])('$situation', ({ lanes, cells }) => {
      const boxes = boxesOf(renderModules(model({ lanes, cells })));
      expect(boxes.length).toBe(lanes.flat().length);
      expect(overlapping(boxes)).toEqual([]);
    });

    it('wraps a long name inside its box', () => {
      const svg = renderModules(model({ lanes: [[{ ...area('x'), name: 'a-very-long-area-name-with-no-room-to-spare-anywhere-at-all' }]] }));
      const [box] = boxesOf(svg);
      const lines = [...svg.matchAll(/<text class="t-h" x="[\d.]+" y="[\d.]+">([^<]*)<\/text>/g)].map((each) => each[1]).filter((each) => each !== 'Lane 0');
      expect(lines.join('')).toBe('a-very-long-area-name-with-no-room-to-spare-anywhere-at-all');
      expect(lines.length).toBeGreaterThan(1);
      for (const line of lines) expect(line.length * 7.9).toBeLessThanOrEqual(box.width);
    });
  });
});
