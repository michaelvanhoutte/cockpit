import { describe, expect, it } from 'vitest';

import { renderModules } from '../../src/render/modules.js';

const area = (path, name = path) => ({ path, name, description: `${name} does its job`, role: 'core', state: 'described', breaches: [] });
const model = ({ lanes, cells = [], undecidedPairs = [], connectors = [], workers = [], parts = [] }) => {
  const layers = lanes.map((paths, index) => ({ title: `Lane ${index}`, note: '', areas: paths.map((each) => (typeof each === 'string' ? area(each) : each)) }));
  const paths = layers.flatMap((each) => each.areas.map((one) => one.path));
  return {
    modules: { layers, connectors, workers, releasedOnItsOwn: parts },
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
        lanes: [['a', { ...area('b'), breaches: ['one.ts', 'two.ts', 'three.ts', 'four.ts'].map((file) => ({ file, import: '@cockpit/shared' })) }, 'c']],
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

  describe('each declared source is a connector box: solid with its package, dashed red when it has none or the package is gone', () => {
    const connector = (id, packageState, inCore = []) => ({ id, name: id.toUpperCase(), package: packageState ? { path: `packages/connectors/${id}`, state: packageState } : null, inCore });
    const connectorBoxes = (svg) => Object.fromEntries([...svg.matchAll(/<rect class="([a-z]+)" data-connector="([^"]*)"/g)].map((each) => [each[2], each[1]]));
    const connectorLane = (connectors, areas = [{ ...area('packages/connectors/teams'), role: 'connector' }]) => renderModules(model({ lanes: [['a'], areas], connectors }));

    it.each([
      { situation: 'a source whose package exists', connector: connector('teams', 'present'), outline: 'clean', says: ['TEAMS', '10 lines', 'Imports only the connector SDK'] },
      { situation: 'a source with no package', connector: connector('gmail', null), outline: 'ghost', says: ['No package of its own'] },
      { situation: 'a source naming a package that is not on disk', connector: connector('claude', 'gone'), outline: 'ghost', says: ['Package gone:', 'packages/connectors/claude is', 'not on disk'] },
    ])('$situation', ({ connector: each, outline, says }) => {
      const svg = connectorLane([each], [{ ...area(`packages/connectors/${each.id}`), role: 'connector' }]);
      expect(connectorBoxes(svg)).toEqual({ [each.id]: outline });
      for (const text of says) expect(svg).toContain(text);
    });

    it('draws a package the description file names as its connector’s box and not a second time as an area', () => {
      const svg = connectorLane([connector('teams', 'present')]);
      expect(boxesOf(svg).map((each) => each.area)).toEqual(['a']);
      expect(Object.keys(connectorBoxes(svg))).toEqual(['teams']);
    });

    it('draws no connector box and no lane for it where nothing is declared', () => {
      const svg = renderModules(model({ lanes: [['a']] }));
      expect(connectorBoxes(svg)).toEqual({});
      expect(svg).not.toContain('>Connectors</text>');
    });

    it('draws one dashed red line from a connector to each core area holding its files, labelled with how many', () => {
      const svg = renderModules(model({ lanes: [['a', 'b']], connectors: [connector('gmail', null, [{ area: 'a', files: ['one.ts', 'two.ts'] }, { area: 'b', files: ['three.ts'] }])] }));
      expect([...svg.matchAll(/<path class="edge-core" data-connector="gmail" data-area="([^"]*)"/g)].map((each) => each[1])).toEqual(['a', 'b']);
      expect(svg).toContain('3 files in the core');
      expect(labels(svg)).toEqual(['up 2 files', 'up 1 file']);
    });

    it('draws no connector box overlapping an area box', () => {
      const svg = renderModules(model({ lanes: [['a', 'b'], ['c']], cells: [down('a', 'c', 1)], connectors: [connector('gmail', null), connector('claude', null), connector('teams', 'present')] }));
      expect(overlapping([...boxesOf(svg), ...[...svg.matchAll(/<rect class="[a-z]+" data-connector="([^"]*)" x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/g)].map((each) => ({ area: each[1], x: Number(each[2]), y: Number(each[3]), width: Number(each[4]), height: Number(each[5]) }))])).toEqual([]);
    });
  });

  describe('each Worker is an outline round every lane, and a part released on its own is a box outside it', () => {
    const worker = { name: 'cockpit', main: 'src/worker.ts', environments: ['production'], areas: ['a', 'b'] };
    const part = { name: 'Teams app', path: 'packages/connectors/teams/teams-app', description: 'Its manifest, zipped and uploaded by hand.', state: 'present' };
    const rectOf = (svg, pattern) => {
      const found = svg.match(pattern);
      return found && { x: Number(found[1]), y: Number(found[2]), width: Number(found[3]), height: Number(found[4]) };
    };
    const outline = (svg) => rectOf(svg, /<rect class="wline" data-worker="cockpit" x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/);

    it('holds every box inside the outline and the released part outside it', () => {
      const svg = renderModules(model({ lanes: [['a'], ['b']], workers: [worker], parts: [part] }));
      const frame = outline(svg);
      expect(svg).toContain('One release: the Worker cockpit');
      for (const box of boxesOf(svg)) {
        expect(box.x).toBeGreaterThan(frame.x);
        expect(box.x + box.width).toBeLessThan(frame.x + frame.width);
        expect(box.y).toBeGreaterThan(frame.y);
        expect(box.y + box.height).toBeLessThan(frame.y + frame.height);
      }
      const released = rectOf(svg, /<rect class="part" data-part="[^"]*" x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/);
      expect(released.x).toBeGreaterThan(frame.x + frame.width);
      expect(svg).toContain('Released on its own');
      expect(svg).toContain('Teams app');
    });

    it.each([
      { situation: 'no Worker deployed', workers: [], parts: [], outlines: 0, boxes: 0 },
      { situation: 'two Workers, outlined one inside the other', workers: [worker, { ...worker, name: 'second' }], parts: [], outlines: 2, boxes: 0 },
      { situation: 'nothing declared as released on its own', workers: [worker], parts: [], outlines: 1, boxes: 0 },
      { situation: 'a part whose folder is gone, drawn dashed', workers: [worker], parts: [{ ...part, state: 'gone' }], outlines: 1, boxes: 1 },
    ])('$situation', ({ workers, parts, outlines, boxes }) => {
      const svg = renderModules(model({ lanes: [['a']], workers, parts }));
      expect(svg.match(/class="wline"/g) ?? []).toHaveLength(outlines);
      expect(svg.match(/data-part="/g) ?? []).toHaveLength(boxes);
      if (parts[0]?.state === 'gone') expect(svg).toMatch(/class="ghost" data-part=/);
    });
  });
});
