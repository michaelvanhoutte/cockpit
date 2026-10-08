import { describe, expect, it } from 'vitest';

import { codeOf, importsOf } from '../../src/scan.js';
import { buildModel } from '../../src/model.js';
import { descriptionFile } from '../support/description.js';

const WRANGLER = { file: 'apps/api/wrangler.jsonc', text: '{ "name": "w" }' };

/** A folder discovery found: its files, each with the text it holds (null for what is not read). */
const folder = (path, files, { role = 'core', pkg = false } = {}) => ({
  path,
  package: pkg,
  role,
  files: Object.entries(files).map(([file, text]) => ({ file: `${path.replace(/\/\*$/, '')}/${file}`, text })),
});

const layer = (areas, role = 'core') => ({ title: 'Layer', note: '', role, areas });
const area = (path, description = `${path} does its job`, role) => ({ path, description, ...(role ? { role } : {}) });

const modulesOf = ({ layers = [], candidates = [], overrides = {} }) =>
  buildModel({ wrangler: WRANGLER, workflows: [], description: descriptionFile({ layers, ...overrides }), candidates, commit: null, date: null }).modules;

const find = (modules, path) => modules.layers.flatMap((each) => each.areas).find((each) => each.path === path);

describe('Modules', () => {
  describe('every area on disk appears, described or marked undescribed', () => {
    it.each([
      {
        situation: 'a folder the file describes is shown with its description',
        layers: [layer([area('apps/api/src/http', 'The routes')])],
        candidates: [folder('apps/api/src/http', { 'app.ts': 'export {}' })],
        expected: { state: 'described', description: 'The routes' },
      },
      {
        situation: 'a folder the file does not mention is shown, marked undescribed',
        layers: [layer([])],
        candidates: [folder('apps/api/src/http', { 'app.ts': 'export {}' })],
        expected: { state: 'undescribed', description: null },
      },
      {
        situation: 'an entry in the file for a folder no longer on disk is shown, marked gone',
        layers: [layer([area('apps/api/src/old', 'Used to exist')])],
        candidates: [],
        expected: { state: 'gone', description: 'Used to exist' },
      },
    ])('$situation', ({ layers, candidates, expected }) => {
      const path = layers[0].areas[0]?.path ?? 'apps/api/src/http';
      expect(find(modulesOf({ layers, candidates }), path)).toMatchObject(expected);
    });

    it('puts the undescribed areas in a layer of their own after the described ones, and counts each kind', () => {
      const modules = modulesOf({
        layers: [layer([area('apps/api/src/old')])],
        candidates: [folder('apps/api/src/b', { 'x.ts': '' }), folder('apps/api/src/a', { 'x.ts': '' })],
      });
      expect(modules.layers.map((each) => each.areas.map((one) => one.path))).toEqual([['apps/api/src/old'], ['apps/api/src/a', 'apps/api/src/b']]);
      expect(modules.layers[1].undescribed).toBe(true);
      expect(modules.counts).toMatchObject({ areas: 3, undescribed: 2, gone: 1 });
    });

    it('does not count a folder holding only tests as an area, and does count a package with nothing else but its manifest', () => {
      const modules = modulesOf({
        candidates: [
          folder('apps/api/src/spec-only', { 'a.test.ts': 'x', '__tests__/b.ts': 'x', 'tests/c.ts': 'x' }),
          folder('packages/empty', {}, { pkg: true }),
        ],
      });
      expect(modules.layers.flatMap((each) => each.areas.map((one) => one.path))).toEqual(['packages/empty']);
    });
  });

  describe('a core area whose code names a declared source is marked, with the files that name it', () => {
    const core = (files) => find(modulesOf({ layers: [layer([area('apps/api/src/x')])], candidates: [folder('apps/api/src/x', files)] }), 'apps/api/src/x');
    const named = (area) => area.sources.map((each) => [each.id, each.files]);

    it.each([
      { situation: 'an identifier using the name', files: { 'a.ts': 'const checkGmail = 1;' }, expected: [['gmail', ['a.ts']]] },
      { situation: 'a string using the name', files: { 'a.ts': "const label = 'Open in Gmail';" }, expected: [['gmail', ['a.ts']]] },
      { situation: 'the name in capitals', files: { 'a.ts': 'export const GMAIL = "gmail";' }, expected: [['gmail', ['a.ts']]] },
      { situation: 'the name in a snake_case column', files: { 'a.ts': 'select gmail_conversations from t' }, expected: [['gmail', ['a.ts']]] },
      { situation: 'a source named by two words, written three ways', files: { 'a.ts': 'ClaudeCode', 'b.ts': "'claude-code'", 'c.ts': 'CLAUDE_CODE' }, expected: [['claude-code', ['a.ts', 'b.ts', 'c.ts']]] },
      { situation: 'every file that names it, and only those', files: { 'a.ts': 'gmail', 'b.ts': 'other', 'c.ts': 'Gmail' }, expected: [['gmail', ['a.ts', 'c.ts']]] },
      { situation: 'the name only in a line comment', files: { 'a.ts': '// we use Gmail as the example\nconst x = 1;' }, expected: [] },
      { situation: 'the name only in a block comment', files: { 'a.ts': '/** Gmail, say.\n * Claude Code too. */\nexport {};' }, expected: [] },
      { situation: 'the name only after a // inside a string that is not a comment', files: { 'a.ts': "const url = 'https://x/'; // gmail" }, expected: [] },
      { situation: 'the name only inside a longer word', files: { 'a.ts': 'const gmailish = 1; const notgmail = 2; const gmail2 = 3;' }, expected: [] },
      { situation: 'the name inside a template literal expression, past a comment', files: { 'a.ts': 'const s = `a ${ /* x */ gmail }`;' }, expected: [['gmail', ['a.ts']]] },
      { situation: 'a source whose name is not declared', files: { 'a.ts': 'const teams = ["a", "b"]; const label = "Microsoft Teams";' }, expected: [] },
    ])('$situation', ({ files, expected }) => {
      expect(named(core(files))).toEqual(expected);
    });

    it('lists each file once however many times it names the source, and reads the files of a nested folder', () => {
      const found = core({ 'a.ts': 'gmail gmail Gmail', 'deep/er/b.tsx': 'gmail' });
      expect(found.sources).toEqual([{ id: 'gmail', name: 'Gmail', files: ['a.ts', 'deep/er/b.tsx'] }]);
    });

    it('does not mark a connector package for naming its own source', () => {
      const modules = modulesOf({
        layers: [layer([area('packages/connectors/gmail')], 'connector')],
        candidates: [folder('packages/connectors/gmail', { 'src/index.ts': "import type { Connector } from '@cockpit/connector-sdk'; export const gmail = 1;" }, { role: 'connector', pkg: true })],
      });
      expect(find(modules, 'packages/connectors/gmail')).toMatchObject({ sources: [], breaches: [] });
    });

    it('does not read a file it was given no text for', () => {
      const found = find(modulesOf({ layers: [layer([area('apps/api/src/x')])], candidates: [folder('apps/api/src/x', { 'a.json': null, 'b.ts': 'export {}' })] }), 'apps/api/src/x');
      expect(found.sources).toEqual([]);
      expect(found.files).toBe(1);
    });
  });

  describe('a connector package importing anything but the connector SDK is marked', () => {
    const connector = (files) =>
      find(
        modulesOf({ layers: [layer([area('packages/connectors/teams')], 'connector')], candidates: [folder('packages/connectors/teams', files, { role: 'connector', pkg: true })] }),
        'packages/connectors/teams',
      );

    it.each([
      { situation: 'only the SDK, third-party packages and its own files', files: { 'src/a.ts': "import { x } from '@cockpit/connector-sdk';\nimport { jwtVerify } from 'jose';\nimport { y } from './b.js';\nexport * from '../src/c.js';" }, expected: [] },
      { situation: 'a file of the SDK, by its own path', files: { 'src/a.ts': "import { x } from '@cockpit/connector-sdk/extra';" }, expected: [] },
      { situation: 'the shared contract', files: { 'src/a.ts': "import type { Item } from '@cockpit/shared';" }, expected: [{ file: 'src/a.ts', import: '@cockpit/shared' }] },
      { situation: 'the app, by a path out of the package', files: { 'src/a.ts': "import { app } from '../../../../apps/api/src/http/app.js';" }, expected: [{ file: 'src/a.ts', import: '../../../../apps/api/src/http/app.js' }] },
      { situation: 'another package, from a dynamic import', files: { 'src/a.ts': "const m = await import('@cockpit/web');" }, expected: [{ file: 'src/a.ts', import: '@cockpit/web' }] },
      { situation: 'a re-export from the contract', files: { 'src/a.ts': "export { Item } from '@cockpit/shared';" }, expected: [{ file: 'src/a.ts', import: '@cockpit/shared' }] },
      { situation: 'an import that is only in a comment', files: { 'src/a.ts': "// import x from '@cockpit/shared';\n/* import y from '@cockpit/web' */\nexport {};" }, expected: [] },
    ])('$situation', ({ files, expected }) => {
      expect(connector(files).breaches).toEqual(expected);
    });

    it('lists the import with every file that makes it', () => {
      const found = connector({ 'src/a.ts': "import '@cockpit/shared';", 'src/b.ts': "import type { A } from\n  '@cockpit/shared';" });
      expect(found.breaches).toEqual([
        { file: 'src/a.ts', import: '@cockpit/shared' },
        { file: 'src/b.ts', import: '@cockpit/shared' },
      ]);
    });

    it('does not apply to a core area importing the shared contract', () => {
      const found = find(modulesOf({ layers: [layer([area('apps/api/src/x')])], candidates: [folder('apps/api/src/x', { 'a.ts': "import '@cockpit/shared';" })] }), 'apps/api/src/x');
      expect(found.breaches).toEqual([]);
    });
  });

  describe('a role comes from the area\'s own entry, else its layer, else where it was found', () => {
    it('takes an area\'s own role over its layer\'s, and the folder\'s role for an undescribed area', () => {
      const modules = modulesOf({
        layers: [layer([area('packages/config', 'Config', 'other'), area('packages/shared')])],
        candidates: [folder('packages/config', { 'a.ts': '' }), folder('packages/shared', { 'a.ts': '' }), folder('packages/connectors/new', { 'a.ts': '' }, { role: 'connector', pkg: true })],
      });
      expect(['packages/config', 'packages/shared', 'packages/connectors/new'].map((path) => find(modules, path).role)).toEqual(['other', 'core', 'connector']);
    });
  });
});

describe('Reading source code', () => {
  it('blanks comments and keeps strings, templates and JSX text', () => {
    const code = codeOf("a // c1\nb /* c2 */ c '// not' `t ${ d /* c3 */ } // not` <p>e</p>");
    expect(code).not.toMatch(/c[123]/);
    expect(code).toContain("'// not'");
    expect(code).toContain('t ${ d');
    expect(code).toContain('<p>e</p>');
  });

  it('is not thrown off by a regular expression, a division or an apostrophe in JSX text', () => {
    expect(codeOf('const r = /["\']\\/\\//g; // gmail\nconst x = a / b; // gmail')).not.toContain('gmail');
    expect(codeOf("<p>Don't use</p>\n// gmail\nconst y = 1;")).not.toContain('gmail');
  });

  it('reads import, export-from, dynamic import and require, not a word that merely contains them', () => {
    expect(importsOf("import a from 'a'; import { b,\n c } from \"b\"; export * from 'c'; import 'd'; const e = await import('e'); const f = require('f'); const reimport = 'g';")).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });
});
