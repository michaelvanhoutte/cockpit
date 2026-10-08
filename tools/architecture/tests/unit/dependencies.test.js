import { describe, expect, it } from 'vitest';

import { buildModel } from '../../src/model.js';
import { parseDescription } from '../../src/description.js';
import { ReadError } from '../../src/errors.js';
import { descriptionFile } from '../support/description.js';

const WRANGLER = { file: 'apps/api/wrangler.jsonc', text: '{ "name": "w" }' };

/** A folder discovery found: its files, each with the text it holds (null for what is not read). */
const folder = (path, files, { pkg = false, packageName = null } = {}) => ({
  path,
  package: pkg,
  packageName,
  role: 'core',
  files: Object.entries(files).map(([file, text]) => ({ file: `${path.replace(/\/\*$/, '')}/${file}`, text })),
});

/** One layer holding the areas in the order given; a name `x` is the folder apps/api/src/x. */
const layers = (...areas) => [{ title: 'Layer', note: '', role: 'core', areas: areas.map((path) => ({ path, description: `${path} does its job` })) }];
const at = (name) => `apps/api/src/${name}`;

const dependenciesOf = ({ areas, candidates, overrides = {} }) =>
  buildModel({ wrangler: WRANGLER, workflows: [], description: descriptionFile({ layers: layers(...areas), ...overrides }), candidates, commit: null, date: null }).dependencies;

const cells = (dependencies) => dependencies.cells.map((each) => [each.from.split('/').pop(), each.to.split('/').pop(), each.files, each.kind]);

describe('Dependencies', () => {
  describe('each cell counts the files in one area that import another', () => {
    const run = (files, extra = []) =>
      cells(dependenciesOf({ areas: [at('a'), at('b'), 'packages/shared'], candidates: [folder(at('a'), files), folder(at('b'), { 'x.ts': 'export {}', 'tests/y.ts': null }), folder('packages/shared', { 'index.ts': 'export {}' }, { pkg: true, packageName: '@cockpit/shared' }), ...extra] }));

    it.each([
      { situation: 'a relative import into another area', files: { 'f.ts': "import { x } from '../b/x.js';" }, expected: [['a', 'b', 1, 'downward']] },
      { situation: 'a relative import that leaves out the extension', files: { 'f.ts': "import { x } from '../b/x';" }, expected: [['a', 'b', 1, 'downward']] },
      { situation: 'an import of a workspace package by name', files: { 'f.ts': "import { z } from '@cockpit/shared';" }, expected: [['a', 'shared', 1, 'downward']] },
      { situation: 'an import of a file inside a workspace package, by name', files: { 'f.ts': "import { z } from '@cockpit/shared/schemas';" }, expected: [['a', 'shared', 1, 'downward']] },
      { situation: 'an import within the same area', files: { 'f.ts': "import { g } from './g.js';", 'g.ts': "import { f } from './f.js';" }, expected: [] },
      { situation: 'two imports of the same area from one file', files: { 'f.ts': "import { x } from '../b/x.js';\nimport { y } from '../b/x';" }, expected: [['a', 'b', 1, 'downward']] },
      { situation: 'two files each importing the area', files: { 'f.ts': "import { x } from '../b/x.js';", 'g.ts': "import { x } from '../b/x.js';" }, expected: [['a', 'b', 2, 'downward']] },
      { situation: 'a type-only import', files: { 'f.ts': "import type { X } from '../b/x.js';" }, expected: [['a', 'b', 1, 'downward']] },
      { situation: 'a re-export from another area', files: { 'f.ts': "export * from '../b/x.js';\nexport { y } from '@cockpit/shared';" }, expected: [['a', 'b', 1, 'downward'], ['a', 'shared', 1, 'downward']] },
      { situation: 'a third-party package', files: { 'f.ts': "import { Hono } from 'hono';" }, expected: [] },
      { situation: 'a test file’s import', files: { 'f.test.ts': "import { x } from '../b/x.js';", 'tests/h.ts': "import { x } from '../b/x.js';" }, expected: [] },
    ])('$situation', ({ files, expected }) => {
      expect(run(files)).toEqual(expected);
    });

    it('counts an import of a folder by its index file in the area that folder is, and not in the root files beside it', () => {
      const dependencies = dependenciesOf({
        areas: [at('*'), at('b')],
        candidates: [folder(at('*'), { 'worker.ts': "import { x } from './b';" }), folder(at('b'), { 'index.ts': 'export {}' })],
      });
      expect(cells(dependencies)).toEqual([['*', 'b', 1, 'downward']]);
    });
  });

  describe('the areas stand in dependency-chain order, each above what it imports', () => {
    const run = (areas, imports, overrides = {}) =>
      dependenciesOf({
        areas: areas.map(at),
        overrides,
        candidates: areas.map((name) => folder(at(name), { 'x.ts': 'export {}', ...Object.fromEntries((imports[name] ?? []).map((target, index) => [`f${index}.ts`, `import '../${target}/x.js';`])) })),
      });
    const order = (dependencies) => dependencies.areas.map((each) => each.path.split('/').pop());

    it.each([
      { situation: 'a chain listed in any order', areas: ['c', 'a', 'b'], imports: { a: ['b'], b: ['c'] }, expected: ['a', 'b', 'c'] },
      { situation: 'a cycle of unequal halves', areas: ['b', 'a'], imports: { a: ['b', 'b', 'b'], b: ['a'] }, expected: ['a', 'b'] },
    ])('$situation', ({ areas, imports, expected }) => {
      expect(order(run(areas, imports))).toEqual(expected);
    });

    it('puts the area everything reads last, and never counts its imports', () => {
      const dependencies = run(['env', 'a', 'b'], { a: ['b'], env: ['a', 'b'] }, { readByEveryone: [at('env')] });
      expect(order(dependencies)).toEqual(['a', 'b', 'env']);
      expect(dependencies.order.upwardFiles).toBe(0);
      expect(cells(dependencies)).toEqual([['a', 'b', 1, 'downward'], ['env', 'a', 1, 'muted'], ['env', 'b', 1, 'muted']]);
    });

    it('lets a pin put an area above another where the chain would not', () => {
      const dependencies = run(['a', 'b'], { a: ['b', 'b', 'b'], b: ['a'] }, { pins: [{ above: at('b'), below: at('a') }] });
      expect(order(dependencies)).toEqual(['b', 'a']);
      expect(cells(dependencies)).toEqual([['b', 'a', 1, 'partner'], ['a', 'b', 3, 'upward']]);
    });

    it('says whether the order is exact, and how many files still point up', () => {
      expect(run(['a', 'b'], { a: ['b'], b: ['a'] }).order).toMatchObject({ method: 'exact', areas: 2, upwardFiles: 1 });
    });

    it.each([
      { situation: 'a pin naming an area no layer describes', pins: [{ above: at('a'), below: at('typo') }] },
      { situation: 'a pin of an area above itself', pins: [{ above: at('a'), below: at('a') }] },
      { situation: 'two pins that put each area above the other', pins: [{ above: at('a'), below: at('b') }, { above: at('b'), below: at('a') }] },
      { situation: 'a pin on the area everything reads', pins: [{ above: at('env'), below: at('a') }], readByEveryone: [at('env')] },
      { situation: 'pins that are not a list', pins: 'a above b' },
    ])('refuses $situation', ({ pins, readByEveryone }) => {
      const areas = ['a', 'b', 'env'].map((name) => ({ path: at(name), description: 'x' }));
      expect(() => parseDescription('d.yml', descriptionFile({ layers: [{ title: 'L', role: 'core', areas }], pins, readByEveryone }).text)).toThrow(ReadError);
    });
  });

  describe('a cycle marks only its upward half, and a one-way import up is marked too', () => {
    const marked = (a, b, overrides) =>
      dependenciesOf({ areas: [at('a'), at('b')], overrides, candidates: [folder(at('a'), a), folder(at('b'), b)] });
    const manyFiles = (count, target) => Object.fromEntries(Array.from({ length: count }, (_, index) => [`f${index}.ts`, `import '../${target}/x.js';`]));

    it('marks the half back up the chain and outlines the other, for halves of unequal size', () => {
      const dependencies = marked(manyFiles(3, 'b'), manyFiles(1, 'a'));
      expect(cells(dependencies)).toEqual([['a', 'b', 3, 'partner'], ['b', 'a', 1, 'upward']]);
      expect(dependencies.cyclePairs).toEqual([[at('a'), at('b')]]);
      expect(dependencies.undecidedPairs).toEqual([]);
    });

    it('marks one half and says the order could not decide the pair, for halves of equal size', () => {
      const dependencies = marked(manyFiles(2, 'b'), manyFiles(2, 'a'));
      expect(cells(dependencies).map((each) => each[3]).sort()).toEqual(['partner', 'upward']);
      expect(dependencies.undecidedPairs).toEqual([[at('a'), at('b')]]);
    });

    it('does not call a pair undecided when a pin decided it', () => {
      const dependencies = marked(manyFiles(2, 'b'), manyFiles(2, 'a'), { pins: [{ above: at('a'), below: at('b') }] });
      expect(dependencies.undecidedPairs).toEqual([]);
    });

    it('does not call a pair undecided when a chain of pins through a third area decided it', () => {
      const dependencies = dependenciesOf({
        areas: [at('a'), at('b'), at('c')],
        overrides: { pins: [{ above: at('a'), below: at('c') }, { above: at('c'), below: at('b') }] },
        candidates: [folder(at('a'), manyFiles(2, 'b')), folder(at('b'), manyFiles(2, 'a')), folder(at('c'), { 'g.ts': 'export {}' })],
      });
      expect(dependencies.cyclePairs).toEqual([[at('a'), at('b')]]);
      expect(dependencies.undecidedPairs).toEqual([]);
    });

    it('marks a one-way import up, under a pin, with no outlined partner', () => {
      const dependencies = marked(manyFiles(1, 'b'), { 'g.ts': 'export {}' }, { pins: [{ above: at('b'), below: at('a') }] });
      expect(cells(dependencies)).toEqual([['a', 'b', 1, 'upward']]);
      expect(dependencies.cyclePairs).toEqual([]);
    });

    it('leaves an import down the chain, with no import back, ordinary', () => {
      const dependencies = marked(manyFiles(1, 'b'), { 'g.ts': 'export {}' });
      expect(cells(dependencies)).toEqual([['a', 'b', 1, 'downward']]);
    });
  });

  describe('an area the description file declares read by everything is muted', () => {
    it('never marks it as part of a cycle', () => {
      const dependencies = dependenciesOf({
        areas: [at('a'), at('*')],
        overrides: { readByEveryone: [at('*')] },
        candidates: [folder(at('a'), { 'f.ts': "import '../env.js';" }), folder(at('*'), { 'env.ts': "import './a/f.js';" })],
      });
      expect(cells(dependencies)).toEqual([['a', '*', 1, 'muted'], ['*', 'a', 1, 'muted']]);
      expect(dependencies.cyclePairs).toEqual([]);
      expect(dependencies.areas.map((each) => each.muted)).toEqual([false, true]);
    });
  });

  describe('the description file labels the areas', () => {
    it('labels an area by its name or else its path', () => {
      const description = (extra) => parseDescription('d.yml', descriptionFile({ layers: [{ title: 'L', role: 'core', areas: [{ path: at('a'), description: 'x', ...extra }] }] }).text);
      expect(description({ name: 'alpha' }).layers[0].areas[0].name).toBe('alpha');
      expect(description({}).layers[0].areas[0].name).toBe(at('a'));
    });

    it('refuses a read-by-everyone path that no layer describes, which would mute nothing', () => {
      expect(() => parseDescription('d.yml', descriptionFile({ layers: [{ title: 'L', role: 'core', areas: [{ path: at('a'), description: 'x' }] }], readByEveryone: [at('typo')] }).text)).toThrow(ReadError);
    });

    it('refuses a read-by-everyone list that is not a list of paths', () => {
      expect(() => parseDescription('d.yml', descriptionFile({ readByEveryone: 'apps/api/src/*' }).text)).toThrow(ReadError);
    });
  });

  describe('each area’s size counts its source lines, without tests', () => {
    it.each([
      { situation: 'a file with a final newline', files: { 'a.ts': 'one\ntwo\n' }, expected: 2 },
      { situation: 'a file without one', files: { 'a.ts': 'one\ntwo' }, expected: 2 },
      { situation: 'an empty file', files: { 'a.ts': '' }, expected: 0 },
      { situation: 'several files, a test among them', files: { 'a.ts': 'x\ny\n', 'b.tsx': 'z\n', 'a.test.ts': null, 'tests/c.ts': null }, expected: 3 },
    ])('$situation', ({ files, expected }) => {
      const dependencies = dependenciesOf({ areas: [at('a')], candidates: [folder(at('a'), files)] });
      expect(dependencies.areas[0].lines).toBe(expected);
    });
  });
});
