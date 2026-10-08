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

  describe('each dependency is marked by its direction in the declared layer order', () => {
    const marked = (a, b) =>
      cells(dependenciesOf({ areas: [at('a'), at('b')], candidates: [folder(at('a'), { 'f.ts': a }), folder(at('b'), { 'g.ts': b })] }));

    it.each([
      { situation: 'an area importing one below it', a: "import '../b/g.js';", b: 'export {}', expected: [['a', 'b', 1, 'downward']] },
      { situation: 'an area importing one above it', a: 'export {}', b: "import '../a/f.js';", expected: [['b', 'a', 1, 'upward']] },
      { situation: 'two areas importing each other, both cells marked', a: "import '../b/g.js';", b: "import '../a/f.js';", expected: [['a', 'b', 1, 'mutual'], ['b', 'a', 1, 'mutual']] },
    ])('$situation', ({ a, b, expected }) => {
      expect(marked(a, b)).toEqual(expected);
    });

    it('lists each mutual pair once, the earlier area first', () => {
      const dependencies = dependenciesOf({ areas: [at('a'), at('b')], candidates: [folder(at('a'), { 'f.ts': "import '../b/g.js';" }), folder(at('b'), { 'g.ts': "import '../a/f.js';" })] });
      expect(dependencies.mutualPairs).toEqual([[at('a'), at('b')]]);
    });

    it('mutes an area the description file declares read by everything, never marking it mutual', () => {
      const dependencies = dependenciesOf({
        areas: [at('a'), at('*')],
        overrides: { readByEveryone: [at('*')] },
        candidates: [folder(at('a'), { 'f.ts': "import '../env.js';" }), folder(at('*'), { 'env.ts': "import './a/f.js';" })],
      });
      expect(cells(dependencies)).toEqual([['a', '*', 1, 'muted'], ['*', 'a', 1, 'muted']]);
      expect(dependencies.mutualPairs).toEqual([]);
      expect(dependencies.areas.map((each) => each.muted)).toEqual([false, true]);
    });

    it('keeps the order the description file gives, and labels an area by its name or else its path', () => {
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
