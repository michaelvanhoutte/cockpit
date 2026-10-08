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

const modulesOf = ({ layers = [], candidates = [], overrides = {}, config = WRANGLER.text }) =>
  buildModel({ wrangler: { ...WRANGLER, text: config }, workflows: [], description: descriptionFile({ layers, ...overrides }), candidates, commit: null, date: null }).modules;

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

  describe('every declared source is a connector, solid with its package when that is on disk', () => {
    const gmail = { id: 'gmail', name: 'Gmail', words: ['gmail'] };
    const withPackage = { ...gmail, package: 'packages/connectors/gmail' };
    const connectorOf = (source, candidates) => modulesOf({ candidates, overrides: { sources: [source] } }).connectors;

    it.each([
      { situation: 'a source whose named package exists', source: withPackage, candidates: [folder('packages/connectors/gmail', { 'src/a.ts': 'export {}' }, { role: 'connector', pkg: true })], expected: { path: 'packages/connectors/gmail', state: 'present' } },
      { situation: 'a source with no package named', source: gmail, candidates: [], expected: null },
      { situation: 'a source naming a package that is not on disk', source: withPackage, candidates: [], expected: { path: 'packages/connectors/gmail', state: 'gone' } },
    ])('$situation', ({ source, candidates, expected }) => {
      const [connector] = connectorOf(source, candidates);
      expect(connector).toMatchObject({ id: 'gmail', name: 'Gmail', package: expected });
    });

    it('has a connector for every source and nothing else', () => {
      expect(connectorOf(gmail, []).map((each) => each.id)).toEqual(['gmail']);
      expect(modulesOf({ overrides: { sources: [] } }).connectors).toEqual([]);
    });
  });

  describe('a core file whose name carries a connector’s words is that connector’s, counted per core area', () => {
    const inCore = ({ candidates, overrides = {}, source = {} }) =>
      modulesOf({
        layers: [layer([area('apps/api/src/x'), area('apps/web/src'), area('apps/api/src/connectors')])],
        candidates,
        overrides: { sources: [{ id: 'gmail', name: 'Gmail', words: ['gmail'], ...source }, { id: 'claude-code', name: 'Claude Code', words: ['claude code'] }], ...overrides },
      }).connectors.map((each) => [each.id, each.inCore.map((here) => [here.area, here.files])]);

    it.each([
      { situation: 'two files in one core area', candidates: [folder('apps/api/src/x', { 'gmail-check.ts': '', 'gmail.ts': '' })], expected: [['gmail', [['apps/api/src/x', ['gmail-check.ts', 'gmail.ts']]]], ['claude-code', []]] },
      { situation: 'a component in the web app, one line to that area', candidates: [folder('apps/web/src', { 'components/ConnectGmail.tsx': '' })], expected: [['gmail', [['apps/web/src', ['components/ConnectGmail.tsx']]]], ['claude-code', []]] },
      { situation: 'files in two areas, one line to each', candidates: [folder('apps/api/src/x', { 'gmail.ts': '' }), folder('apps/web/src', { 'ChangeGmailFollows.tsx': '' })], expected: [['gmail', [['apps/api/src/x', ['gmail.ts']], ['apps/web/src', ['ChangeGmailFollows.tsx']]]], ['claude-code', []]] },
      { situation: 'a source of two words, written as a file name', candidates: [folder('apps/api/src/x', { 'claude-code-hooks.ts': '', 'ConnectClaudeCode.tsx': '' })], expected: [['gmail', []], ['claude-code', [['apps/api/src/x', ['ConnectClaudeCode.tsx', 'claude-code-hooks.ts']]]]] },
      { situation: 'a file only mentioning the name inside', candidates: [folder('apps/api/src/x', { 'a.ts': "const label = 'Open in Gmail'; // gmail" })], expected: [['gmail', []], ['claude-code', []]] },
      { situation: 'the word only inside a longer word in a file name', candidates: [folder('apps/api/src/x', { 'gmailish.ts': '', 'notgmail.ts': '', 'gmail2.ts': '' })], expected: [['gmail', []], ['claude-code', []]] },
      { situation: 'the word only in a folder name', candidates: [folder('apps/api/src/x', { 'gmail/index.ts': '' })], expected: [['gmail', []], ['claude-code', []]] },
      {
        situation: 'the composition root',
        candidates: [folder('apps/api/src/connectors', { 'gmail-registry.ts': '', 'gmail.ts': '' })],
        overrides: { exemptFromSources: ['apps/api/src/connectors/gmail-registry.ts'] },
        expected: [['gmail', [['apps/api/src/connectors', ['gmail.ts']]]], ['claude-code', []]],
      },
      { situation: 'a file inside the connector’s own package', candidates: [folder('apps/api/src/x', { 'gmail.ts': '' }), folder('packages/connectors/gmail', { 'gmail.ts': '' }, { pkg: true })], source: { package: 'packages/connectors/gmail' }, expected: [['gmail', [['apps/api/src/x', ['gmail.ts']]]], ['claude-code', []]] },
    ])('$situation', ({ candidates, overrides, source, expected }) => {
      expect(inCore({ candidates, overrides, source })).toEqual(expected);
    });

    it('never counts a file of a connector package that is itself a core area', () => {
      const modules = modulesOf({
        layers: [layer([area('packages/connectors/gmail')])],
        candidates: [folder('packages/connectors/gmail', { 'gmail.ts': '' }, { pkg: true })],
        overrides: { sources: [{ id: 'gmail', name: 'Gmail', words: ['gmail'], package: 'packages/connectors/gmail' }] },
      });
      expect(modules.connectors[0].inCore).toEqual([]);
    });
  });

  describe('each Worker the config deploys is one outline round everything bundled into it, and each part released on its own is a box outside', () => {
    const layers = [layer([area('apps/web/src'), area('apps/api/src/http'), area('packages/shared'), area('packages/config', 'Config', 'other'), area('apps/api/src/old')])];
    const candidates = [folder('apps/web/src', { 'a.ts': '' }), folder('apps/api/src/http', { 'a.ts': '' }), folder('packages/shared', { 'a.ts': '' }, { pkg: true }), folder('packages/config', { 'a.ts': '' }, { pkg: true })];

    it('holds every area of the web app, the API and the packages in the config’s one Worker, however many environments run it', () => {
      const { workers } = modulesOf({ layers, candidates, config: '{ "name": "w", "main": "src/worker.ts", "env": { "staging": {} } }' });
      expect(workers).toEqual([{ name: 'w', main: 'src/worker.ts', environments: ['production', 'staging'], areas: ['apps/web/src', 'apps/api/src/http', 'packages/shared'] }]);
    });

    it('draws one outline for each distinct entry point the config deploys', () => {
      const { workers } = modulesOf({ layers, candidates, config: '{ "name": "w", "main": "a.ts", "env": { "other": { "name": "o", "main": "b.ts" } } }' });
      expect(workers.map((each) => [each.name, each.environments])).toEqual([['w', ['production']], ['o', ['other']]]);
    });

    it.each([
      { situation: 'a declared separately released part that is on disk', parts: [{ name: 'Teams app', path: 'packages/shared/app', description: 'd' }], files: { 'app/manifest.json': '{}' }, expected: [{ name: 'Teams app', path: 'packages/shared/app', state: 'present' }] },
      { situation: 'a declared part whose folder is missing', parts: [{ name: 'Teams app', path: 'packages/shared/app', description: 'd' }], files: {}, expected: [{ name: 'Teams app', path: 'packages/shared/app', state: 'gone' }] },
      { situation: 'nothing declared', parts: undefined, files: { 'app/manifest.json': '{}' }, expected: [] },
    ])('$situation', ({ parts, files, expected }) => {
      const { releasedOnItsOwn } = modulesOf({ layers, candidates: [folder('packages/shared', { 'a.ts': '', ...files }, { pkg: true })], overrides: parts ? { releasedOnItsOwn: parts } : {} });
      expect(releasedOnItsOwn.map(({ name, path, state }) => ({ name, path, state }))).toEqual(expected);
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
