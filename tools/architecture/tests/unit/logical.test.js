import { describe, expect, it } from 'vitest';

import { parseDescription } from '../../src/description.js';
import { ReadError } from '../../src/errors.js';
import { buildLogical } from '../../src/logical.js';
import { LOGICAL_FILE, renderLogicalPage } from '../../src/render/logical.js';
import { descriptionFile } from '../support/description.js';

const chip = (id, extra = {}) => ({ id, name: id, ...extra });

/** A small design in the real one's shape: clients, API, logic, data and connectors, with Google outside. */
const design = (overrides = {}) => ({
  layers: [
    { id: 'clients', title: 'Clients', kind: 'clients', row: 0, items: [[chip('web', { folders: ['apps/web/src'] })]] },
    { id: 'api', title: 'API layer', row: 1, items: [[chip('http', { folders: ['apps/api/src/http'] }), chip('auth', { folders: ['apps/api/src/auth'] })]] },
    { id: 'logic', title: 'Business logic', row: 2, items: [[chip('accounts', { folders: ['apps/api/src/accounts'] }), chip('domain', { folders: ['apps/api/src/domain'] })]] },
    { id: 'data', title: 'Data', row: 3, share: 0.6, items: [[chip('d1', { kind: 'store', folders: ['apps/api/src/db'], marker: '\\benv\\.DB\\b', how: 'SQL' })]] },
    { id: 'conn', title: 'Connectors', row: 3, share: 0.4, items: [[chip('gmail', { folders: ['packages/connectors/gmail'] })]] },
    { id: 'outside', title: 'Outside services', kind: 'outside', alignedWith: 'logic', items: [[chip('google', { kind: 'outside', marker: 'accounts\\.google\\.com', how: 'HTTPS' })]] },
  ],
  mayCall: { clients: ['api'], api: ['logic'], logic: ['data', 'outside'], conn: ['outside'] },
  breaks: { 'logic>api': 'Business logic depends on the API layer above it' },
  callers: [],
  noLine: [],
  ...overrides,
});

/** The design as the description file reads it, so these tests go through the same checks the run does. */
const parsed = (overrides) => parseDescription('d.yml', descriptionFile({ design: design(overrides) }).text).design;

const folder = (path, files) => ({ path, package: false, packageName: null, role: 'core', files: Object.entries(files).map(([file, text]) => ({ file: `${path}/${file}`, text })) });
const pack = (path, name, files) => ({ ...folder(path, files), package: true, packageName: name });

const everything = [
  folder('apps/web/src', {}),
  folder('apps/api/src/http', {}),
  folder('apps/api/src/auth', {}),
  folder('apps/api/src/accounts', {}),
  folder('apps/api/src/domain', {}),
  folder('apps/api/src/db', {}),
  pack('packages/connectors/gmail', '@cockpit/connector-gmail', {}),
];

/** `everything`, with each folder's files replaced where given. */
const code = (files = {}, extra = {}) => {
  const logical = buildLogical({ design: parsed(extra.design), scan: { extensions: ['.ts', '.tsx'] }, candidates: everything.map((each) => (files[each.path] ? folder(each.path, files[each.path]) : each)), callerCode: extra.callerCode });
  return logical;
};

describe('A line the design allows, and the code makes, is one grey line per pair of layers, labelled with how many files make it', () => {
  it.each([
    {
      situation: 'one file in the API layer imports Business logic',
      files: { 'apps/api/src/http': { 'a.ts': "import { x } from '../accounts/store.js';" } },
      expected: [['api', 'logic', 1]],
    },
    {
      situation: 'three files across two component pairs between the same two layers',
      files: { 'apps/api/src/http': { 'a.ts': "import '../accounts/x.js';", 'b.ts': "import '../accounts/x.js';\nimport '../domain/y.js';" }, 'apps/api/src/auth': { 'c.ts': "import '../domain/y.js';" } },
      expected: [['api', 'logic', 3]],
    },
  ])('$situation', ({ files, expected }) => {
    const logical = code({ ...files, 'apps/api/src/accounts': { 'x.ts': '', 'store.ts': '' }, 'apps/api/src/domain': { 'y.ts': '' } });
    expect(logical.ok.map((each) => [each.a, each.b, each.files.length])).toEqual(expected);
    expect(logical.bad).toEqual([]);
  });
});

describe('Code the design does not allow is a numbered red line between the two components, listing each file at the line that makes it', () => {
  const only = (logical) => logical.bad.map((each) => [each.n, each.from, each.to, each.files, each.at]);

  it('is red from a Business logic file that imports the API layer', () => {
    const logical = code({ 'apps/api/src/accounts': { 'a.ts': "import '../http/app.js';" }, 'apps/api/src/http': { 'app.ts': '' } });
    expect(only(logical)).toEqual([[1, 'accounts', 'http', ['apps/api/src/accounts/a.ts'], { 'apps/api/src/accounts/a.ts': 1 }]]);
    expect(logical.bad[0].why).toBe('Business logic depends on the API layer above it');
  });

  it('is red from an API layer file that contains a store\'s marker, and names how it reached it', () => {
    const logical = code({ 'apps/api/src/http': { 'a.ts': 'const x = 1;\nawait env.DB.prepare(q);' } });
    expect(only(logical)).toEqual([[1, 'http', 'd1', ['apps/api/src/http/a.ts'], { 'apps/api/src/http/a.ts': 2 }]]);
    expect(logical.bad[0]).toMatchObject({ kind: 'store', how: ['SQL'], a: 'api', b: 'data' });
  });

  it('is red from an API layer file that contains an outside service\'s host', () => {
    const logical = code({ 'apps/api/src/auth': { 'i.ts': "const url = 'https://accounts.google.com/o/oauth2';" } });
    expect(only(logical)).toEqual([[1, 'auth', 'google', ['apps/api/src/auth/i.ts'], { 'apps/api/src/auth/i.ts': 1 }]]);
    expect(logical.bad[0].why).toBe('API layer → Outside services: not a line the design draws');
  });

  it('is one line with two file links when two files make the same line, each at its own line', () => {
    const logical = code({ 'apps/api/src/http': { 'a.ts': 'env.DB.x();', 'b.ts': '\n\nenv.DB.y();' } });
    expect(only(logical)).toEqual([[1, 'http', 'd1', ['apps/api/src/http/a.ts', 'apps/api/src/http/b.ts'], { 'apps/api/src/http/a.ts': 1, 'apps/api/src/http/b.ts': 3 }]]);
  });

  it('is no line when the marker appears only in a comment', () => {
    const logical = code({ 'apps/api/src/http': { 'a.ts': '// env.DB is read in db/\n/*\n * env.DB again\n */\nexport {};' } });
    expect(logical.bad).toEqual([]);
    expect(logical.evidence).toEqual([]);
  });

  it('numbers the lines in the order the design lists their components', () => {
    const logical = code({ 'apps/api/src/http': { 'a.ts': 'env.DB;' }, 'apps/api/src/auth': { 'a.ts': 'env.DB;' } });
    expect(logical.bad.map((each) => [each.n, each.id, each.from])).toEqual([[1, 'off-1', 'http'], [2, 'off-2', 'auth']]);
  });
});

describe('A line between two components in one layer is counted on the layer, never drawn and never red', () => {
  it('counts Accounts importing Domain on Business logic', () => {
    const logical = code({ 'apps/api/src/accounts': { 'a.ts': "import '../domain/y.js';" }, 'apps/api/src/domain': { 'y.ts': '' } });
    expect(logical.inside).toEqual({ logic: 1 });
    expect(logical.bad).toEqual([]);
    expect(logical.ok).toEqual([]);
    expect(renderLogicalPage({ logical, drawnFrom: { commit: null, repo: null } })).toContain('1 line inside, not drawn');
  });
});

describe('A pair of layers the design allows, that no file uses, is drawn dotted', () => {
  it('lists Connectors to Outside services when no connector file does it', () => {
    const logical = code({ 'apps/api/src/accounts': { 'a.ts': "import '../db/schema.js';" } });
    expect(logical.miss).toContainEqual({ a: 'conn', b: 'outside' });
    expect(logical.miss).not.toContainEqual({ a: 'logic', b: 'data' });
    const page = renderLogicalPage({ logical, drawnFrom: { commit: null, repo: null } });
    expect(page).toContain('class="nl nl-miss f-L-conn t-L-outside');
    expect(page).toContain('<td>Connectors</td><td>Outside services</td><td>the design draws it; no file does it</td>');
  });
});

describe('A declared caller is looked for in its own code where this repository holds it', () => {
  const callers = (code) => [{ from: 'web', to: 'http', how: 'REST /v1', code }];
  const webFiles = { 'apps/web/src': [{ file: 'apps/web/src/api.ts', text: "// '/v1/x' only here\nfetch('/v1/items');" }, { file: 'apps/web/src/other.ts', text: 'export {};' }] };
  const run = (declared, callerCode) => code({}, { design: { callers: declared }, callerCode }).callers;

  it('is found, with each file at its line, when the files contain its marker', () => {
    expect(run(callers({ folder: 'apps/web/src', marker: '/v1/' }), webFiles)).toEqual([{ from: 'web', to: 'http', how: 'REST /v1', status: 'found', files: ['apps/web/src/api.ts'], at: { 'apps/web/src/api.ts': 2 } }]);
  });

  it('is not found, and drawn dotted, when no file of the caller contains its marker', () => {
    const [caller] = run(callers({ folder: 'apps/web/src', marker: '/never/' }), webFiles);
    expect(caller).toMatchObject({ status: 'notFound', files: [] });
    const page = renderLogicalPage({ logical: code({}, { design: { callers: callers({ folder: 'apps/web/src', marker: '/never/' }) }, callerCode: webFiles }), drawnFrom: { commit: null, repo: null } });
    expect(page).toContain('class="nl nl-miss f-web t-http');
    expect(page).toContain('declared as <i>REST /v1</i>; not found in its code');
  });

  it('says its code is not in this repository, and still draws the dashed line, when it declares no code', () => {
    const logical = code({}, { design: { callers: callers(undefined) } });
    expect(logical.callers).toEqual([{ from: 'web', to: 'http', how: 'REST /v1', status: 'elsewhere', files: [], at: {} }]);
    const page = renderLogicalPage({ logical, drawnFrom: { commit: null, repo: null } });
    expect(page).toContain('its code is not in this repository');
    expect(page).toContain('class="nl nl-decl f-web t-http');
  });
});

describe('Every folder of the code is in exactly one component of the design', () => {
  it('records a folder no component names, a component naming a folder that is gone, and a folder in two components', () => {
    const logical = buildLogical({
      design: parsed({ noLine: [{ folder: 'apps/api/src/domain', name: 'domain' }] }),
      scan: { extensions: ['.ts'] },
      candidates: [...everything.filter((each) => each.path !== 'apps/api/src/db'), folder('apps/api/src/stray', {})],
    });
    expect(logical.placement).toEqual({
      unplaced: ['apps/api/src/stray'],
      gone: [{ folder: 'apps/api/src/db', components: ['d1'] }],
      doubled: [{ folder: 'apps/api/src/domain', components: ['domain', 'domain (drawn as no line)'] }],
    });
  });

  it('records nothing when every folder is placed once, and says so on no page', () => {
    const logical = code();
    expect(logical.placement).toEqual({ unplaced: [], gone: [], doubled: [] });
    expect(renderLogicalPage({ logical, drawnFrom: { commit: null, repo: null } })).not.toContain('does not match the code');
  });

  it('names each problem on the page', () => {
    const logical = buildLogical({ design: parsed(), scan: { extensions: ['.ts'] }, candidates: [...everything, folder('apps/api/src/stray', {})] });
    expect(renderLogicalPage({ logical, drawnFrom: { commit: null, repo: null } })).toContain('<code>apps/api/src/stray</code> is in no component');
  });
});

describe('The design section is checked as the rest of the description file is', () => {
  const read = (overrides) => parseDescription('d.yml', descriptionFile({ design: design(overrides) }).text);

  it('reads a valid design', () => {
    expect(read({}).design.layers.map((each) => each.id)).toEqual(['clients', 'api', 'logic', 'data', 'conn', 'outside']);
  });

  it.each([
    { situation: 'a layer the may-call rules name does not exist', overrides: { mayCall: { api: ['nowhere'] } }, message: 'names nowhere' },
    { situation: 'a layer is described twice', overrides: { layers: [...design().layers, design().layers[0]] }, message: 'is used twice' },
    { situation: 'a marker is not a regular expression', overrides: { layers: [{ id: 'd', title: 'D', items: [[chip('s', { kind: 'store', marker: '(' })]] }] }, message: 'is not a regular expression' },
    { situation: 'a caller names a chip that is not in the design', overrides: { callers: [{ from: 'ghost', to: 'http', how: 'x' }] }, message: 'is not a design chip' },
    { situation: 'a component names no folder', overrides: { layers: [{ id: 'd', title: 'D', items: [[chip('c')]] }] }, message: 'names no folder' },
  ])('fails the run when $situation', ({ overrides, message }) => {
    expect(() => read(overrides)).toThrow(ReadError);
    expect(() => read(overrides)).toThrow(message);
  });

  it('has no design when the file has no section, and draws no page', () => {
    expect(parseDescription('d.yml', descriptionFile().text).design).toBeNull();
  });
});

describe('Every GitHub link opens the code at the commit the page was drawn from', () => {
  const logical = code({ 'apps/api/src/http': { 'a.ts': 'const x = 1;\nenv.DB.q();' } });
  const page = renderLogicalPage({ logical, drawnFrom: { commit: 'abc1234def5678', repo: 'o/r' } });

  it('opens a component\'s folder', () => {
    expect(page).toContain('<a class="code" href="https://github.com/o/r/tree/abc1234def5678/apps/api/src/http"');
    expect(page).toContain('Open on GitHub: apps/api/src/http');
  });

  it('opens a file in a red line\'s row at the line that makes it', () => {
    expect(page).toContain('<a class="gh" href="https://github.com/o/r/blob/abc1234def5678/apps/api/src/http/a.ts#L2" target="_blank" rel="noopener"><code>apps/api/src/http/a.ts:2</code></a>');
  });

  it('gives a component with no folder no link', () => {
    expect(page.match(/<g class="node n-google">(.*?)<\/g>/s)[1]).not.toContain('<a ');
  });

  it('links nothing when the repository or the commit is not known, and says so', () => {
    const bare = renderLogicalPage({ logical, drawnFrom: { commit: null, repo: null } });
    expect(bare).not.toContain('github.com');
    expect(bare).toContain('commit <b>not known</b>');
  });

  it('writes the page as service-cockpit.html', () => {
    expect(LOGICAL_FILE).toBe('service-cockpit.html');
  });
});
