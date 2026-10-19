//
// Unit tests for buildImportGraph, in `tests/lint` rather than `scripts/lib`,
// whose CI job is checkout-only and could not import the TypeScript parser (see
// import-rules.test.mjs). Each case is a row of the statement list from "Build
// the import graph of the workspace's sources" (issue 1281), over an in-memory
// file map. Rule 4's one case, the whole workspace read in seconds, is measured
// once in the E2E job's log and has no pure equivalent here.
//

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildImportGraph } from '../../scripts/lib/import-graph.mjs';

const PACKAGES = [
  { name: '@cockpit/shared', dir: 'packages/shared' },
  { name: '@cockpit/web', dir: 'apps/web' },
];

/** A graph over `files`, a path to its text; a value of `''` is a file that is not read. */
const graphOf = (files, packages = PACKAGES) => buildImportGraph(files, packages);

describe('every static import form is an edge', () => {
  const importing = (line) => graphOf({ 'a.ts': line, 'b.ts': 'export const b = 1;' });

  it('a default or named import from a relative path', () => {
    assert.deepEqual(importing("import b from './b';").importersOf('b.ts'), ['a.ts']);
    assert.deepEqual(importing("import { b } from './b';").importersOf('b.ts'), ['a.ts']);
  });

  it('a side-effect import', () => {
    assert.deepEqual(importing("import './b';").importersOf('b.ts'), ['a.ts']);
  });

  it('an export-from', () => {
    assert.deepEqual(importing("export { b } from './b';").importersOf('b.ts'), ['a.ts']);
    assert.deepEqual(importing("export * from './b';").importersOf('b.ts'), ['a.ts']);
  });

  it('a type-only import', () => {
    assert.deepEqual(importing("import type { B } from './b';").importersOf('b.ts'), ['a.ts']);
    assert.deepEqual(importing("import { type B } from './b';").importersOf('b.ts'), ['a.ts']);
  });

  it('a dynamic import with a string literal', () => {
    assert.deepEqual(importing("const load = () => import('./b');").importersOf('b.ts'), ['a.ts']);
  });

  it('a dynamic import with a template literal that substitutes nothing is a literal', () => {
    const graph = importing('const load = () => import(`./b`);');
    assert.deepEqual(graph.importersOf('b.ts'), ['a.ts']);
    assert.deepEqual(graph.computedImports, []);
  });

  it('a computed dynamic import names its file and gives no edge', () => {
    const graph = importing("const load = (name: string) => import(`./${name}`);\nconst other = () => import(path);");
    assert.deepEqual(graph.importersOf('b.ts'), []);
    assert.deepEqual(graph.computedImports, [
      { file: 'a.ts', line: 1 },
      { file: 'a.ts', line: 2 },
    ]);
    assert.deepEqual(graph.unresolved, []);
  });

  it('a bare third-party name', () => {
    const graph = importing("import { useState } from 'react';\nimport { join } from 'node:path';\nimport x from '@tanstack/react-router';");
    assert.deepEqual(graph.unresolved, []);
    assert.deepEqual(graph.computedImports, []);
    assert.deepEqual(graph.importersOf('b.ts'), []);
  });
});

describe('a specifier resolves as the toolchain does', () => {
  it('an omitted extension tries the toolchain candidates in its order', () => {
    const importer = "import './b';";
    const ordered = ['b.ts', 'b.tsx', 'b.mts', 'b.js', 'b.jsx', 'b.mjs'];
    for (const [index, winner] of ordered.entries()) {
      const files = { 'a.ts': importer };
      for (const later of ordered.slice(index)) files[later] = '';
      const graph = graphOf(files);
      assert.deepEqual(graph.importersOf(winner), ['a.ts'], `${winner} wins over ${ordered.slice(index + 1).join(', ') || 'nothing'}`);
      for (const loser of ordered.slice(index + 1)) assert.deepEqual(graph.importersOf(loser), [], loser);
    }
  });

  it('a directory resolves to its index file', () => {
    const graph = graphOf({ 'a.ts': "import './lib';\nimport './lib/inner/';", 'lib/index.ts': '', 'lib/inner/index.tsx': '' });
    assert.deepEqual(graph.importersOf('lib/index.ts'), ['a.ts']);
    assert.deepEqual(graph.importersOf('lib/inner/index.tsx'), ['a.ts']);
  });

  it('a file beats a directory of the same name', () => {
    const graph = graphOf({ 'a.ts': "import './lib';", 'lib.ts': '', 'lib/index.ts': '' });
    assert.deepEqual(graph.importersOf('lib.ts'), ['a.ts']);
    assert.deepEqual(graph.importersOf('lib/index.ts'), []);
  });

  it('a .js specifier for a .ts source resolves to the source', () => {
    const graph = graphOf({ 'a.ts': "import './b.js';\nimport './c.jsx';\nimport './d.mjs';", 'b.ts': '', 'c.tsx': '', 'd.mts': '' });
    assert.deepEqual(graph.importersOf('b.ts'), ['a.ts']);
    assert.deepEqual(graph.importersOf('c.tsx'), ['a.ts']);
    assert.deepEqual(graph.importersOf('d.mts'), ['a.ts']);
    assert.deepEqual(graph.unresolved, []);
  });

  it('a declaration file is not a source', () => {
    const graph = graphOf({ 'a.ts': "import './b';", 'b.d.ts': 'export declare const b: 1;' });
    assert.deepEqual(graph.importersOf('b.d.ts'), []);
    assert.deepEqual(graph.unresolved, [{ importer: 'a.ts', specifier: './b' }]);
  });

  it('a workspace package name resolves to that package source entry, read from its manifest', () => {
    const graph = graphOf({
      'apps/web/src/a.ts': "import { x } from '@cockpit/shared';",
      'packages/shared/package.json': JSON.stringify({ name: '@cockpit/shared', exports: { '.': { types: './src/types.d.ts', default: './src/index.ts' } } }),
      'packages/shared/src/index.ts': '',
      'packages/shared/src/types.d.ts': '',
    });
    assert.deepEqual(graph.importersOf('packages/shared/src/index.ts'), ['apps/web/src/a.ts']);
    assert.deepEqual(graph.unresolved, []);
  });

  it('a workspace package with only a main field resolves through it', () => {
    const graph = graphOf({
      'apps/web/src/a.ts': "import '@cockpit/shared';",
      'packages/shared/package.json': JSON.stringify({ name: '@cockpit/shared', main: './lib/entry.ts' }),
      'packages/shared/lib/entry.ts': '',
    });
    assert.deepEqual(graph.importersOf('packages/shared/lib/entry.ts'), ['apps/web/src/a.ts']);
  });

  it('a subpath of a workspace package resolves through its exports, and one it does not export is unresolved', () => {
    const graph = graphOf({
      'apps/web/src/a.ts': "import '@cockpit/shared/schemas';\nimport '@cockpit/shared/things/one';\nimport '@cockpit/shared/private';",
      'packages/shared/package.json': JSON.stringify({
        name: '@cockpit/shared',
        exports: { '.': './src/index.ts', './schemas': './src/schemas.ts', './things/*': './src/things/*.ts' },
      }),
      'packages/shared/src/schemas.ts': '',
      'packages/shared/src/things/one.ts': '',
      'packages/shared/src/private.ts': '',
    });
    assert.deepEqual(graph.importersOf('packages/shared/src/schemas.ts'), ['apps/web/src/a.ts']);
    assert.deepEqual(graph.importersOf('packages/shared/src/things/one.ts'), ['apps/web/src/a.ts']);
    assert.deepEqual(graph.importersOf('packages/shared/src/private.ts'), []);
    assert.deepEqual(graph.unresolved, [{ importer: 'apps/web/src/a.ts', specifier: '@cockpit/shared/private' }]);
  });

  it('a subpath pattern with the longest part before its star wins', () => {
    const graph = graphOf({
      'apps/web/src/a.ts': "import '@cockpit/shared/things/one';",
      'packages/shared/package.json': JSON.stringify({
        name: '@cockpit/shared',
        exports: { './*': './src/*.ts', './things/*': './src/deep/*.ts' },
      }),
      'packages/shared/src/things/one.ts': '',
      'packages/shared/src/deep/one.ts': '',
    });
    assert.deepEqual(graph.importersOf('packages/shared/src/deep/one.ts'), ['apps/web/src/a.ts']);
    assert.deepEqual(graph.importersOf('packages/shared/src/things/one.ts'), []);
  });

  it('a workspace package whose manifest names no existing entry is unresolved', () => {
    const graph = graphOf({
      'apps/web/src/a.ts': "import '@cockpit/shared';",
      'packages/shared/package.json': JSON.stringify({ name: '@cockpit/shared', exports: { '.': './src/gone.ts' } }),
    });
    assert.deepEqual(graph.unresolved, [{ importer: 'apps/web/src/a.ts', specifier: '@cockpit/shared' }]);
  });

  it('a stylesheet, JSON or image asset resolves to the file itself', () => {
    const graph = graphOf({
      'src/a.tsx': "import './a.css';\nimport data from './data.json';\nimport logo from './logo.svg';\nimport styles from './a.css?raw';\nimport icon from './icon.png?url';",
      'src/a.css': '',
      'src/data.json': '',
      'src/logo.svg': '',
      'src/icon.png': '',
    });
    assert.deepEqual(graph.importersOf('src/a.css'), ['src/a.tsx']);
    assert.deepEqual(graph.importersOf('src/data.json'), ['src/a.tsx']);
    assert.deepEqual(graph.importersOf('src/logo.svg'), ['src/a.tsx']);
    assert.deepEqual(graph.importersOf('src/icon.png'), ['src/a.tsx']);
    assert.deepEqual(graph.unresolved, []);
  });

  it('a specifier naming no file gives no edge and the pair is named among unresolved', () => {
    const graph = graphOf({ 'src/a.ts': "import './missing';\nimport '../../../outside';\nimport '@cockpit/shared/none';", 'src/b.ts': "import './missing';" });
    assert.deepEqual(graph.unresolved, [
      { importer: 'src/a.ts', specifier: '../../../outside' },
      { importer: 'src/a.ts', specifier: './missing' },
      { importer: 'src/a.ts', specifier: '@cockpit/shared/none' },
      { importer: 'src/b.ts', specifier: './missing' },
    ]);
  });
});

describe('importers are found as far as needed, and a cycle ends', () => {
  it('A imports B, B imports C: the importers of C are B and A', () => {
    const graph = graphOf({ 'a.ts': "import './b';", 'b.ts': "import './c';", 'c.ts': '' });
    assert.deepEqual(graph.importersOf('c.ts'), ['b.ts']);
    assert.deepEqual(graph.transitiveImportersOf('c.ts'), ['a.ts', 'b.ts']);
    assert.deepEqual(graph.transitiveImportersOf('b.ts'), ['a.ts']);
  });

  it('A and B import each other: it ends, and each is the other importer', () => {
    const graph = graphOf({ 'a.ts': "import './b';", 'b.ts': "import './a';", 'c.ts': "import './a';" });
    assert.deepEqual(graph.transitiveImportersOf('a.ts'), ['b.ts', 'c.ts']);
    assert.deepEqual(graph.transitiveImportersOf('b.ts'), ['a.ts', 'c.ts']);
    assert.deepEqual(graph.importersOf('a.ts'), ['b.ts', 'c.ts']);
  });

  it('a file nothing imports has no importers', () => {
    const graph = graphOf({ 'a.ts': "import './b';", 'b.ts': '', 'lonely.ts': '' });
    assert.deepEqual(graph.importersOf('lonely.ts'), []);
    assert.deepEqual(graph.transitiveImportersOf('lonely.ts'), []);
    assert.deepEqual(graph.transitiveImportersOf('not-in-the-map.ts'), []);
  });
});

describe('the whole workspace is read', () => {
  it('counts the source files it parsed, not the assets beside them', () => {
    const graph = graphOf({ 'a.ts': '', 'b.tsx': '', 'c.mjs': '', 'types.d.ts': '', 'a.css': '', 'package.json': '{}' });
    assert.equal(graph.filesRead, 3);
  });
});
