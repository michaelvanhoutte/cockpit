import { describe, expect, it } from 'vitest';

import { ReadError } from '../../src/errors.js';
import { buildLogical } from '../../src/logical.js';
import { LOGICAL_FILE, renderLogicalPage } from '../../src/render/logical.js';
import { readDescription } from '../support/description.js';

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
const parsed = (overrides) => readDescription({ design: design(overrides) }).design;

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
  });

  it('reports a line at its place in the file when a block comment above it spans several lines', () => {
    const logical = code({ 'apps/api/src/http': { 'a.ts': '/*\n env.DB\n*/\nexport {};\nenv.DB.x();' } });
    expect(only(logical)).toEqual([[1, 'http', 'd1', ['apps/api/src/http/a.ts'], { 'apps/api/src/http/a.ts': 5 }]]);
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
    expect(run(callers({ folder: 'apps/web/src', marker: '/v1/' }), webFiles)).toEqual([{ from: 'web', to: 'http', how: 'REST /v1', status: 'found', files: ['apps/web/src/api.ts'], at: { 'apps/web/src/api.ts': 2 }, addresses: [] }]);
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
    expect(logical.callers).toEqual([{ from: 'web', to: 'http', how: 'REST /v1', status: 'elsewhere', files: [], at: {}, addresses: [] }]);
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
  const read = (overrides) => readDescription({ design: design(overrides) });

  it('reads a valid design', () => {
    expect(read({}).design.layers.map((each) => each.id)).toEqual(['clients', 'api', 'logic', 'data', 'conn', 'outside']);
  });

  it.each([
    { situation: 'a layer the may-call rules name does not exist', overrides: { mayCall: { api: ['nowhere'] } }, message: 'names nowhere' },
    { situation: 'a layer is described twice', overrides: { layers: [...design().layers, design().layers[0]] }, message: 'is used twice' },
    { situation: 'a marker is not a regular expression', overrides: { layers: [{ id: 'd', title: 'D', items: [[chip('s', { kind: 'store', marker: '(' })]] }] }, message: 'is not a regular expression' },
    { situation: 'a caller names a chip that is not in the design', overrides: { callers: [{ from: 'ghost', to: 'http', how: 'x' }] }, message: 'is not a design chip' },
    { situation: 'a layer has no row and is not drawn beside another', overrides: { layers: [{ id: 'd', title: 'D', items: [[chip('c', { folders: ['x'] })]] }] }, message: 'has no row' },
    { situation: 'a component names no folder', overrides: { layers: [{ id: 'd', title: 'D', items: [[chip('c')]] }] }, message: 'names no folder' },
  ])('fails the run when $situation', ({ overrides, message }) => {
    expect(() => read(overrides)).toThrow(ReadError);
    expect(() => read(overrides)).toThrow(message);
  });

  it('has no design when the file has no section, and draws no page', () => {
    expect(readDescription().design).toBeNull();
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

describe('A deviation is accepted only for the files its acceptance names', () => {
  const bare = { commit: null, repo: null };
  const accept = (files, extra = {}) => ({ accepted: [{ from: 'http', to: 'd1', files, reason: 'Reads straight from the store.', ...extra }] });
  const http = (names) => ({ 'apps/api/src/http': Object.fromEntries(names.map((name, at) => [name, `${'\n'.repeat(at)}env.DB.q();`])) });
  const run = (names, files) => code(http(names), { design: accept(files) });

  it('is grey with a tick and the reason, not numbered and not in the red count, when it names every file that makes the line', () => {
    const logical = run(['a.ts', 'b.ts'], ['apps/api/src/http/a.ts', 'apps/api/src/http/b.ts']);
    expect(logical.bad).toEqual([]);
    expect(logical.accepted.map((each) => [each.id, each.from, each.to, each.accepted.reason])).toEqual([['acc-1', 'http', 'd1', 'Reads straight from the store.']]);
    const page = renderLogicalPage({ logical, drawnFrom: bare });
    expect(page).toContain('class="nl nl-acc f-http t-d1');
    expect(page).toContain('<span class="num num-acc">✓</span>');
    expect(page).toContain('<b class="bad">0 lines</b>');
    expect(page).not.toContain('<tr class="bad"');
  });

  it('stays red, naming the file it does not cover as new, when it names only one of two files', () => {
    const logical = run(['a.ts', 'b.ts'], ['apps/api/src/http/a.ts']);
    expect(logical.accepted).toEqual([]);
    expect(logical.bad.map((each) => [each.n, each.newFiles, each.partly.files])).toEqual([[1, ['apps/api/src/http/b.ts'], ['apps/api/src/http/a.ts']]]);
    expect(renderLogicalPage({ logical, drawnFrom: bare })).toContain('Accepted for a.ts, not for b.ts, which is new.');
  });

  it('is judged by files alone, whatever else makes the pair of components red', () => {
    const logical = code({ 'apps/api/src/http': { 'a.ts': "env.DB.q();\nconst u = 'https://accounts.google.com';" } }, { design: accept(['apps/api/src/http/a.ts']) });
    expect(logical.accepted.map((each) => `${each.from}>${each.to}`)).toEqual(['http>d1']);
    expect(logical.bad.map((each) => `${each.from}>${each.to}`)).toEqual(['http>google']);
  });

  it('is not needed when the design itself now allows the line', () => {
    const logical = code(http(['a.ts']), { design: { ...accept(['apps/api/src/http/a.ts']), mayCall: { clients: ['api'], api: ['logic', 'data'] } } });
    expect(logical.accepted).toEqual([]);
    expect(logical.stale.map((each) => each.to)).toEqual(['d1']);
  });
});

describe('An acceptance the code no longer needs is listed as no longer needed, and fails nothing', () => {
  const bare = { commit: null, repo: null };
  const accept = { accepted: [{ from: 'http', to: 'd1', files: ['apps/api/src/http/old.ts'], reason: 'It was the old way in.' }] };

  it('lists the acceptance with its reason when the line it accepts no longer exists', () => {
    const logical = code({}, { design: accept });
    expect(logical.stale).toHaveLength(1);
    const page = renderLogicalPage({ logical, drawnFrom: bare });
    expect(page).toContain('<span class="bad">No longer needed:</span>');
    expect(page).toContain('It was the old way in.');
    expect(page).not.toContain('class="nl nl-acc');
  });

  it('makes the line red naming the renamed file, and flags the acceptance, when a file it names was renamed', () => {
    const logical = code({ 'apps/api/src/http': { 'new.ts': 'env.DB.q();' } }, { design: accept });
    expect(logical.bad.map((each) => [each.newFiles, each.partly.files])).toEqual([[['apps/api/src/http/new.ts'], ['apps/api/src/http/old.ts']]]);
    expect(logical.stale).toHaveLength(1);
  });

  it('lists nothing as accepted or no longer needed when the design accepts nothing, and the table says None', () => {
    const logical = code();
    expect(logical.accepted).toEqual([]);
    expect(logical.stale).toEqual([]);
    expect(renderLogicalPage({ logical, drawnFrom: bare })).toMatch(/Accepted, with a reason<\/h2>.*?<p class="dim">None\.<\/p>/s);
  });
});

describe('An acceptance is checked as the rest of the description file is', () => {
  const read = (accepted) => readDescription({ design: design({ accepted }) });
  const entry = { from: 'http', to: 'd1', files: ['apps/api/src/http/a.ts'], reason: 'Because.' };

  it('reads a valid acceptance', () => {
    expect(read([entry]).design.accepted).toEqual([{ ...entry, question: null, source: null, agreed: false }]);
  });

  it.each([
    { situation: 'it names a component the design does not have', accepted: [{ ...entry, to: 'ghost' }], message: 'ghost' },
    { situation: 'it has neither a reason nor a question', accepted: [{ ...entry, reason: undefined }], message: 'neither a reason nor a question' },
    { situation: 'its reason is blank', accepted: [{ ...entry, reason: '  ' }], message: 'accepted[0].reason' },
    { situation: 'it covers no file', accepted: [{ ...entry, files: [] }], message: 'at least one file' },
    { situation: 'the pair is accepted twice', accepted: [entry, entry], message: 'already accepts' },
  ])('fails the run, naming the entry, when $situation', ({ accepted, message }) => {
    expect(() => read(accepted)).toThrow(ReadError);
    expect(() => read(accepted)).toThrow(message);
  });
});

describe('A deviation\'s prompt holds everything a fresh session needs to scope it', () => {
  const drawnFrom = { commit: 'abc1234def5678', repo: 'o/r' };
  const accept = (files) => ({ accepted: [{ from: 'http', to: 'd1', files, reason: 'Reads straight from the store.' }] });
  const files = { 'apps/api/src/http': { 'a.ts': 'const x = 1;\nenv.DB.q();', 'b.ts': 'env.DB.r();' } };
  const devsOf = (page) => JSON.parse(page.match(/<script type="application\/json" id="devs">(.*?)<\/script>/s)[1]);
  const pageOf = (design) => renderLogicalPage({ logical: code(files, { design }), drawnFrom });

  it('starts a red deviation with /scoping, names both components and layers, what the first layer may call, each file at its line with its link at the commit, and ends on the choice', () => {
    const [prompt] = Object.values(devsOf(pageOf({}))).map((each) => each.prompt);
    expect(prompt.startsWith('/scoping Fix an architecture deviation in Cockpit.')).toBe(true);
    expect(prompt).toContain('http (API layer) reaches d1 (Data).');
    expect(prompt).toContain('The design lets API layer call only: Business logic.');
    expect(prompt).toContain('Where the code does it, at commit abc1234:');
    expect(prompt).toContain('- apps/api/src/http/a.ts:2 (https://github.com/o/r/blob/abc1234def5678/apps/api/src/http/a.ts#L2)');
    expect(prompt).toContain('- apps/api/src/http/b.ts:1 (https://github.com/o/r/blob/abc1234def5678/apps/api/src/http/b.ts#L1)');
    expect(prompt.endsWith('accept the deviation with a written reason.')).toBe(true);
  });

  it('also names the files accepted, the reason and the new files, when a red deviation is partly accepted', () => {
    const prompt = devsOf(pageOf(accept(['apps/api/src/http/a.ts'])))['off-1'].prompt;
    expect(prompt).toContain('An earlier acceptance covers apps/api/src/http/a.ts ("Reads straight from the store."); apps/api/src/http/b.ts is new.');
  });

  it('is a Reconsider prompt carrying the reason, for an accepted deviation', () => {
    const data = devsOf(pageOf(accept(['apps/api/src/http/a.ts', 'apps/api/src/http/b.ts'])))['acc-1'];
    expect(data.title).toBe('Accepted: http → d1');
    expect(data.prompt.startsWith('/scoping Reconsider an accepted architecture deviation in Cockpit.\n\nIt is accepted today because: Reads straight from the store.')).toBe(true);
  });

  it('leaves out a link, and the commit, when the page does not know them', () => {
    const page = renderLogicalPage({ logical: code(files), drawnFrom: { commit: null, repo: null } });
    const prompt = devsOf(page)['off-1'].prompt;
    expect(prompt).toContain('Where the code does it:\n- apps/api/src/http/a.ts:2\n');
    expect(prompt).not.toContain('https://');
  });

  it('ends the rule it breaks in one full stop, whether or not the design wrote one, and names the dialog by its heading', () => {
    const page = renderLogicalPage({ logical: code({ 'apps/api/src/http': { 'a.ts': 'env.DB.q();' } }, { design: { breaks: { 'api>data': 'Reaches the store directly.' } } }), drawnFrom });
    expect(Object.values(devsOf(page))[0].prompt).toContain('Reaches the store directly.\nThe design lets');
    expect(page).toContain('<dialog id="dev" aria-labelledby="dev-h"><h3 id="dev-h">');
  });

  it('carries the data so that no markup in it can close the script', () => {
    const page = renderLogicalPage({ logical: code({ 'apps/api/src/http': { 'a.ts': 'env.DB.q();' } }, { design: { breaks: { 'api>data': 'a </script> b' } } }), drawnFrom });
    expect(page.match(/<\/script>/g)).toHaveLength(2);
    expect(Object.values(devsOf(page))[0].why).toBe('a </script> b');
  });
});

describe('Every red and tick circle, and every row\'s button, opens its own deviation', () => {
  const drawnFrom = { commit: null, repo: null };
  const idsIn = (page, pattern) => [...page.matchAll(pattern)].map((each) => each[1]);

  it('names an entry in the page\'s data from each circle and button, and every entry is named', () => {
    const logical = code({ 'apps/api/src/http': { 'a.ts': 'env.DB.q();' }, 'apps/api/src/auth': { 'a.ts': 'env.DB.q();' } }, { design: { accepted: [{ from: 'http', to: 'd1', files: ['apps/api/src/http/a.ts'], reason: 'Because.' }] } });
    const page = renderLogicalPage({ logical, drawnFrom });
    const data = Object.keys(JSON.parse(page.match(/id="devs">(.*?)<\/script>/s)[1])).sort();
    expect(data).toEqual(['acc-1', 'off-1']);
    expect(idsIn(page, /<a href="#[^"]*" data-dev="([^"]+)" class="nl-a"/g).sort()).toEqual(['acc-1', 'off-1']);
    expect(idsIn(page, /<button class="copy" data-dev="([^"]+)">/g).sort()).toEqual(['acc-1', 'off-1']);
    expect(page).toContain('>Scope a fix</button>');
    expect(page).toContain('>Reconsider</button>');
  });

  it('carries no dialog and no script, and the tables say None, when the page has no deviation', () => {
    const page = renderLogicalPage({ logical: code(), drawnFrom });
    expect(page).not.toContain('<dialog');
    expect(page).not.toContain('<script');
    expect(page).toContain('None: every line in the code is one the design draws, or one accepted with a reason.');
    expect(page).toContain('<p class="dim">None.</p>');
  });
});

/** A service that keeps its files in one folder: components are file-name patterns in it. */
describe('A component made of file-name patterns holds exactly the files its patterns match', () => {
  const SRC = 'apps/svc/src';
  const patterned = (id, files, extra = {}) => chip(id, { in: SRC, files, ...extra });
  const svc = (overrides = {}) => ({
    layers: [
      { id: 'clients', title: 'Clients', kind: 'clients', row: 0, items: [[chip('cron', { kind: 'client' })]] },
      { id: 'routes', title: 'Routes', row: 1, items: [[patterned('entry', ['worker.*'])]] },
      { id: 'reports', title: 'Reports and jobs', row: 2, items: [[patterned('cycle', ['cycle-time*', 'strip*']), patterned('jobs', ['jobs*'])]] },
      { id: 'data', title: 'Data', row: 3, items: [[chip('db', { kind: 'store', marker: '\\.prepare\\(', how: 'SQL', href: 'db-svc.html', tip: 'Open its tables' })]] },
      { id: 'outside', title: 'Outside', kind: 'outside', alignedWith: 'reports', items: [[chip('cockpit', { kind: 'outside', marker: 'usage-records', how: 'HTTPS', href: 'service-cockpit.html' })]] },
    ],
    mayCall: { clients: ['routes'], routes: ['reports'], reports: ['data', 'outside'] },
    breaks: { 'routes>data': 'A route reads or writes the database itself, past the reports' },
    callers: [{ from: 'cron', to: 'entry', how: 'scheduled()' }],
    noLine: [],
    ...overrides,
  });
  const source = (files) => ({ [SRC]: Object.entries(files).map(([name, text]) => ({ file: `${SRC}/${name}`, text })) });
  const run = (files, design = svc()) => buildLogical({ design: readDescription({ design }).design, scan: { extensions: ['.ts'] }, candidates: [], designFiles: source(files) });
  const normal = { 'worker.ts': '', 'cycle-time.ts': '', 'cycle-time-page.ts': '', 'strip-x.ts': '', 'jobs.ts': '' };
  const chipOf = (logical, id) => logical.layers.flatMap((layer) => layer.items.flat()).find((each) => each.id === id);

  it('puts a file matching one components pattern in that component, and records nothing', () => {
    const logical = run(normal);
    expect(logical.placement).toEqual({ unplaced: [], gone: [], doubled: [] });
    expect(chipOf(logical, 'cycle').matched).toEqual([`${SRC}/cycle-time-page.ts`, `${SRC}/cycle-time.ts`, `${SRC}/strip-x.ts`]);
    expect(chipOf(logical, 'entry').matched).toEqual([`${SRC}/worker.ts`]);
  });

  it('records a file no pattern matches, naming it', () => {
    expect(run({ ...normal, 'stray.ts': '' }).placement).toEqual({ unplaced: [`${SRC}/stray.ts`], gone: [], doubled: [] });
  });

  it('records a file two components patterns match, naming both', () => {
    const both = svc({ layers: svc().layers.map((layer) => (layer.id === 'reports' ? { ...layer, items: [[patterned('cycle', ['cycle-time*', 'strip*']), patterned('jobs', ['jobs*', '*-both*'])]] } : layer)) });
    expect(run({ ...normal, 'cycle-time-both.ts': '' }, both).placement.doubled).toEqual([{ folder: `${SRC}/cycle-time-both.ts`, components: ['cycle', 'jobs'] }]);
  });

  it('records a pattern matching nothing, naming it and its component', () => {
    const { 'strip-x.ts': _gone, ...without } = normal;
    expect(run(without).placement).toEqual({ unplaced: [], gone: [{ folder: `${SRC}/strip*`, components: ['cycle'] }], doubled: [] });
  });

  it('matches the whole name, so a dot in a pattern is a dot', () => {
    expect(run({ ...normal, workerxts: '' }).placement.unplaced).toEqual([`${SRC}/workerxts`]);
  });

  it('reads an import between files placed in different components as a line between them', () => {
    const logical = run({ ...normal, 'cycle-time.ts': "import { x } from './jobs.js';", 'worker.ts': "import { y } from './cycle-time';" });
    expect(logical.inside).toEqual({ reports: 1 });
    expect(logical.ok.map((each) => [each.a, each.b, each.files])).toEqual([['routes', 'reports', [`${SRC}/worker.ts`]]]);
  });
});

describe('The Monitor lines are judged by its own design', () => {
  const SRC = 'apps/svc/src';
  const patterned = (id, files) => chip(id, { in: SRC, files });
  const design = {
    layers: [
      { id: 'routes', title: 'Routes', row: 0, items: [[patterned('entry', ['worker.*'])]] },
      { id: 'reports', title: 'Reports and jobs', row: 1, items: [[patterned('cycle', ['cycle-time*'])]] },
      { id: 'data', title: 'Data', row: 2, items: [[chip('db', { kind: 'store', marker: '\\.prepare\\(', how: 'SQL' })]] },
    ],
    mayCall: { routes: ['reports'], reports: ['data'] },
    breaks: { 'routes>data': 'A route reads or writes the database itself, past the reports' },
    callers: [],
    noLine: [],
  };
  const run = (files) => buildLogical({ design: readDescription({ design }).design, scan: { extensions: ['.ts'] }, candidates: [], designFiles: { [SRC]: Object.entries(files).map(([name, text]) => ({ file: `${SRC}/${name}`, text })) } });

  it('draws one grey line, Reports and jobs to Data, when a report reads the database', () => {
    const logical = run({ 'worker.ts': '', 'cycle-time.ts': 'db.prepare(q);\ndb.prepare(r);' });
    expect(logical.ok.map((each) => [each.a, each.b, each.files.length])).toEqual([['reports', 'data', 1]]);
    expect(logical.bad).toEqual([]);
  });

  it('names the service, not Cockpit, in the prompt of its red line', () => {
    const logical = run({ 'worker.ts': 'db.prepare(q);', 'cycle-time.ts': '' });
    const page = renderLogicalPage({ logical, drawnFrom: { commit: null, repo: null } }, { name: 'Harness Monitor', logical });
    const [prompt] = Object.values(JSON.parse(page.match(/id="devs">(.*?)<\/script>/s)[1])).map((each) => each.prompt);
    expect(prompt.startsWith('/scoping Fix an architecture deviation in Harness Monitor.')).toBe(true);
  });

  it('draws a red line, Routes to the database, when a route runs SQL itself', () => {
    const logical = run({ 'worker.ts': 'const x = 1;\ndb.prepare(q);', 'cycle-time.ts': '' });
    expect(logical.bad.map((each) => [each.n, each.from, each.to, each.why, each.at])).toEqual([[1, 'entry', 'db', 'A route reads or writes the database itself, past the reports', { [`${SRC}/worker.ts`]: 2 }]]);
  });
});

describe('A service page links to its database page, to Cockpit and to its components files', () => {
  const SRC = 'apps/svc/src';
  const design = {
    layers: [
      { id: 'reports', title: 'Reports and jobs', row: 0, items: [[chip('cycle', { in: SRC, files: ['cycle-time*', 'strip*'] }), chip('solo', { in: SRC, files: ['solo*'] })]] },
      { id: 'data', title: 'Data', row: 1, items: [[chip('db', { kind: 'store', marker: '\\.prepare\\(', how: 'SQL', href: 'db-svc.html', tip: 'Open its tables' })]] },
      { id: 'outside', title: 'Outside', kind: 'outside', alignedWith: 'reports', items: [[chip('cockpit', { kind: 'outside', marker: 'usage-records', href: 'service-cockpit.html' })]] },
    ],
    mayCall: { reports: ['data', 'outside'] },
    callers: [],
    noLine: [],
  };
  const logical = buildLogical({
    design: readDescription({ design }).design,
    scan: { extensions: ['.ts'] },
    candidates: [],
    designFiles: { [SRC]: ['cycle-time-b.ts', 'cycle-time-a.ts', 'strip.ts', 'solo.ts'].map((name) => ({ file: `${SRC}/${name}`, text: name === 'solo.ts' ? 'db.prepare(q);' : '' })) },
  });
  const page = renderLogicalPage({ logical, drawnFrom: { commit: 'abc1234def5678', repo: 'o/r' } }, { name: 'Harness Monitor', logical, intro: 'A second Worker.' });
  const node = (id) => page.match(new RegExp(`<g class="node n-${id}">(.*?)</g>`, 's'))[1];

  it('opens the database page from the store chip, with its tooltip', () => {
    expect(node('db')).toContain('<a href="db-svc.html">');
    expect(node('db')).toContain('<title>Open its tables</title>');
  });

  it('opens Cockpit page from the Cockpit chip', () => {
    expect(node('cockpit')).toContain('<a href="service-cockpit.html">');
  });

  it('opens the first file from a component of several, and lists all of them in its tooltip', () => {
    expect(node('cycle')).toContain('<a class="code" href="https://github.com/o/r/blob/abc1234def5678/apps/svc/src/cycle-time-a.ts"');
    expect(node('cycle')).toContain('Open on GitHub: apps/svc/src/cycle-time-a.ts, the first of 3 files:\napps/svc/src/cycle-time-a.ts\napps/svc/src/cycle-time-b.ts\napps/svc/src/strip.ts');
  });

  it('opens the one file of a component of one, without a list', () => {
    expect(node('solo')).toContain('href="https://github.com/o/r/blob/abc1234def5678/apps/svc/src/solo.ts"');
    expect(node('solo')).not.toContain('the first of');
  });

  it('names the service on its page, starts with what it says about itself, and leaves out a callers table with no code to look in', () => {
    expect(page).toContain('<h1>Harness Monitor</h1>');
    expect(page).toContain('<title>Harness Monitor Architecture &middot; Cockpit</title>');
    expect(page).toContain('A second Worker. The layers it is meant to have');
    expect(page).not.toContain('How each caller talks to it');
  });
});

describe('A design of file-name patterns is checked as the rest of the description file is', () => {
  const read = (items) => readDescription({ design: { layers: [{ id: 'd', title: 'D', row: 0, items: [[items]] }], mayCall: {}, callers: [], noLine: [] } });

  it('reads a valid component of patterns', () => {
    expect(read({ id: 'c', name: 'c', in: 'a/b/', files: ['x*'] }).design.layers[0].items[0][0]).toMatchObject({ in: 'a/b', files: ['x*'], folders: [] });
  });

  it.each([
    { situation: 'patterns name no folder to match in', item: { id: 'c', name: 'c', files: ['x*'] }, message: 'needs `in`' },
    { situation: 'a folder is named with no patterns', item: { id: 'c', name: 'c', in: 'a', folders: ['b'] }, message: 'does not name' },
    { situation: 'a link is not the name of a page', item: { id: 's', name: 's', kind: 'store', href: 'https://x.test/a' }, message: 'file name of a page' },
  ])('fails the run when $situation', ({ item, message }) => {
    expect(() => read(item)).toThrow(ReadError);
    expect(() => read(item)).toThrow(message);
  });

  it('reads the services beyond Cockpit, each drawn on a page of its own, and fails on a repeated id', () => {
    const service = (id) => ({ id, name: id, design: { layers: [{ id: 'd', title: 'D', row: 0, items: [[chip('c', { in: 'a', files: ['x*'] })]] }], mayCall: {} } });
    expect(readDescription({ otherServices: [service('harness-monitor')] }).otherServices.map((each) => each.file)).toEqual(['service-harness-monitor.html']);
    expect(() => readDescription({ otherServices: [service('a'), service('a')] })).toThrow('is used twice');
  });
});

describe('A widget part uses another when one of its files names a class or function the other defines', () => {
  const SRC = 'apps/app/src/widget';
  const part = (id, files) => chip(id, { in: SRC, files });
  const widget = (overrides = {}) => ({
    extensions: ['.kt'],
    findLines: 'names',
    layers: [
      { id: 'widget', title: 'App', kind: 'service', row: 0, drawInside: true, subGap: 44, chipW: 190, items: [[part('refresh', ['Refresher.kt']), part('storage', ['Storage.kt']), part('client', ['Client.kt'])], [chip('prefs', { kind: 'store', marker: 'getSharedPreferences', how: 'reads and writes' })]] },
      { id: 'cockpit', title: 'Cockpit: API layer', kind: 'context', href: 'service-cockpit.html', row: 1, items: [[chip('ctx-mcp', { name: 'OAuth, MCP, apps API', folders: ['apps/api/src/mcp'] })]] },
      { id: 'phone', title: 'On the phone', kind: 'outside', alignedWith: 'widget', items: [[chip('browser', { kind: 'outside' })]] },
    ],
    mayCall: { widget: ['cockpit', 'phone'] },
    callers: [],
    noLine: [],
    ...overrides,
  });
  const kotlin = (files) => Object.entries(files).map(([name, text]) => ({ file: `${SRC}/${name}`, text }));
  const normal = { 'Refresher.kt': 'class Refresher {}', 'Storage.kt': 'class WidgetStore {\n  val p = context.getSharedPreferences("a", 0)\n}', 'Client.kt': 'class Client {}' };
  const run = (files = normal, design = widget()) =>
    buildLogical({ design: readDescription({ design }).design, scan: { extensions: ['.ts'] }, candidates: [{ path: 'apps/api/src/mcp', package: false, role: 'core', files: [] }], designFiles: { [SRC]: kotlin(files) } });
  const lines = (logical) => logical.within.filter((each) => each.kind === 'import').map((each) => [each.from, each.to, each.at]);

  it('draws a line, Refresh to Storage, at the line that names the class Storage defines', () => {
    const logical = run({ ...normal, 'Refresher.kt': 'class Refresher {\n  val s = WidgetStore()\n}' });
    expect(lines(logical)).toEqual([['refresh', 'storage', { [`${SRC}/Refresher.kt`]: 2 }]]);
  });

  it('draws no line when the name appears only in a comment', () => {
    expect(lines(run({ ...normal, 'Refresher.kt': 'class Refresher {\n  // uses WidgetStore\n  /* WidgetStore\n     again */\n}' }))).toEqual([]);
  });

  it('draws no line when a part names its own class', () => {
    expect(lines(run({ ...normal, 'Storage.kt': 'class WidgetStore {\n  val me = WidgetStore()\n}' }))).toEqual([]);
  });

  it('matches whole words, and a function counts as a name', () => {
    const logical = run({ ...normal, 'Refresher.kt': 'class Refresher {\n  val a = WidgetStoreful()\n  val b = pick()\n}', 'Client.kt': 'fun pick() = 1\nclass Client {}' });
    expect(lines(logical)).toEqual([['refresh', 'client', { [`${SRC}/Refresher.kt`]: 3 }]]);
  });

  it('takes the name of an extension function, never its receiver, and a suspend or inline one counts', () => {
    const logical = run({ ...normal, 'Client.kt': 'fun View.keepClear() {}\nsuspend fun <T> List<T>.fetch() {}\nclass Client {}', 'Refresher.kt': 'class Refresher {\n  val v = View.GONE\n  val f = fetch()\n}' });
    expect(lines(logical)).toEqual([['refresh', 'client', { [`${SRC}/Refresher.kt`]: 3 }]]);
  });

  it.each([
    { situation: 'a receiver with a generic inside a generic', declaration: 'fun Map<String, List<Int>>.tally() {}', name: 'tally', receiver: 'Map' },
    { situation: 'a generic with a bound before the receiver', declaration: 'fun <T : Comparable<T>> List<T>.tally() {}', name: 'tally', receiver: 'List' },
    { situation: 'a nullable receiver', declaration: 'fun String?.tally() {}', name: 'tally', receiver: 'String' },
    { situation: 'an annotation on the same line', declaration: '@Composable fun Tally() {}', name: 'Tally', receiver: 'Composable' },
    { situation: 'a type alias', declaration: 'typealias Tally = Map<String, Int>', name: 'Tally', receiver: 'Map' },
    { situation: 'a function interface', declaration: 'public fun interface Tally { fun run() }', name: 'Tally', receiver: 'run' },
  ])('defines $name and not $receiver for $situation', ({ declaration, name, receiver }) => {
    const use = (word) => run({ ...normal, 'Client.kt': `${declaration}\nclass Client {}`, 'Refresher.kt': `class Refresher {\n  val a = ${word}\n}` });
    expect(lines(use(name)).map(([from, to]) => `${from}>${to}`)).toEqual(['refresh>client']);
    expect(lines(use(receiver))).toEqual([]);
  });

  it('leaves a private declaration out of the names other files can use', () => {
    expect(lines(run({ ...normal, 'Client.kt': 'private fun hidden() {}\nclass Client {}', 'Refresher.kt': 'class Refresher {\n  val a = hidden()\n}' }))).toEqual([]);
  });

  it('draws the store a part reaches by its marker as a line to it', () => {
    const [line] = run().within;
    expect([line.from, line.to, line.kind, line.how]).toEqual(['storage', 'prefs', 'store', ['reads and writes']]);
  });

  it('names a Kotlin file no part names, and a pattern matching no file', () => {
    expect(run({ ...normal, 'New.kt': 'class New' }).placement).toEqual({ unplaced: [`${SRC}/New.kt`], gone: [], doubled: [] });
    const { 'Client.kt': _gone, ...without } = normal;
    expect(run(without).placement.gone).toEqual([{ folder: `${SRC}/Client.kt`, components: ['client'] }]);
  });

  it('places the context box\'s components by nothing, and records one whose folder is gone', () => {
    expect(run().placement).toEqual({ unplaced: [], gone: [], doubled: [] });
    const gone = widget({ layers: widget().layers.map((layer) => (layer.id === 'cockpit' ? { ...layer, items: [[chip('ctx-mcp', { folders: ['apps/api/src/nowhere'] })]] } : layer)) });
    expect(run(normal, gone).placement.gone).toEqual([{ folder: 'apps/api/src/nowhere', components: ['ctx-mcp'] }]);
  });
});

describe('The widget\'s line out carries the addresses its client calls', () => {
  const SRC = 'apps/app/src/widget';
  const design = {
    extensions: ['.kt'],
    layers: [
      { id: 'widget', title: 'App', kind: 'service', row: 0, items: [[chip('client', { in: SRC, files: ['Client.kt'] }), chip('signin', { in: SRC, files: ['SignIn.kt'] })]] },
      { id: 'cockpit', title: 'Cockpit: API layer', kind: 'context', row: 1, items: [[chip('ctx-mcp', { name: 'OAuth, MCP, apps API', folders: ['apps/api/src/mcp'] })]] },
      { id: 'phone', title: 'On the phone', kind: 'outside', alignedWith: 'widget', items: [[chip('browser', { kind: 'outside' })]] },
    ],
    mayCall: { widget: ['cockpit', 'phone'] },
    callers: [
      { from: 'client', to: 'ctx-mcp', how: 'Bearer', code: { folder: SRC, only: ['Client.kt'], extensions: ['.kt'], addresses: '"\\$root(/[a-z0-9/]+)"' } },
      { from: 'signin', to: 'browser', how: '/oauth/authorize, PKCE' },
    ],
    noLine: [],
  };
  const render = (client, other = '') => {
    const files = [{ file: `${SRC}/Client.kt`, text: client }, { file: `${SRC}/SignIn.kt`, text: other }];
    const logical = buildLogical({ design: readDescription({ design }).design, scan: { extensions: ['.ts'] }, candidates: [{ path: 'apps/api/src/mcp', package: false, role: 'core', files: [] }], designFiles: { [SRC]: files }, callerCode: { [SRC]: files } });
    return { logical, page: renderLogicalPage({ logical, drawnFrom: { commit: 'abc1234def5678', repo: 'o/r' } }, { name: 'Widget', id: 'widget', logical, intro: 'The box, opened.' }) };
  };

  it('labels the line to the OAuth, MCP and apps API with every address, once each, then how', () => {
    const { logical, page } = render('get("$root/apps/v1/panels")\npost("$root/oauth/token")\npost("$root/oauth/token")', 'val x = "$root/apps"');
    expect(logical.callers[0]).toMatchObject({ status: 'found', addresses: ['/apps/v1/panels', '/oauth/token'], files: [`${SRC}/Client.kt`] });
    expect(page).toContain('/apps/v1/panels, /oauth/token · Bearer');
    expect(page).toContain('class="nl nl-decl f-client t-ctx-mcp');
  });

  it('leaves out an address that only a comment holds', () => {
    expect(render('// get("$root/never")\nget("$root/oauth/token")').logical.callers[0].addresses).toEqual(['/oauth/token']);
  });

  it('is dotted, as not found, when the client calls nothing that matches', () => {
    const { logical, page } = render('val x = 1');
    expect(logical.callers[0]).toMatchObject({ status: 'notFound', addresses: [], files: [] });
    expect(page).toContain('class="nl nl-miss f-client t-ctx-mcp');
    expect(page).toContain('not found in the code');
  });

  it('draws the second declared line to the phone\'s browser, with no code to look in', () => {
    const { logical, page } = render('get("$root/oauth/token")');
    expect(logical.callers[1]).toMatchObject({ from: 'signin', to: 'browser', status: 'elsewhere' });
    expect(page).toContain('class="nl nl-decl f-signin t-browser');
  });
});

describe('The widget\'s page opens its box, lays Cockpit\'s API layer beneath it and says how its lines are found', () => {
  const SRC = 'apps/app/src/widget';
  const files = [{ file: `${SRC}/Client.kt`, text: 'class Client { val s = Store() }' }, { file: `${SRC}/Store.kt`, text: 'class Store' }];
  const design = {
    findLines: 'names',
    extensions: ['.kt'],
    layers: [
      { id: 'widget', title: 'App', kind: 'service', row: 0, drawInside: true, items: [[chip('client', { in: SRC, files: ['Client.kt'] }), chip('store', { in: SRC, files: ['Store.kt'] })]] },
      { id: 'cockpit', title: 'Cockpit: API layer', kind: 'context', href: 'service-cockpit.html', row: 1, items: [[chip('ctx-mcp', { name: 'OAuth, MCP, apps API', folders: ['apps/api/src/mcp'] })]] },
    ],
    mayCall: { widget: ['cockpit'] },
    callers: [],
    noLine: [],
  };
  const logical = buildLogical({ design: readDescription({ design }).design, scan: { extensions: ['.ts'] }, candidates: [{ path: 'apps/api/src/mcp', package: false, role: 'core', files: [] }], designFiles: { [SRC]: files } });
  const page = renderLogicalPage({ logical, drawnFrom: { commit: 'abc1234def5678', repo: 'o/r' } }, { name: 'Widget', id: 'widget', logical, intro: 'The box, opened.' });
  const node = (id) => page.match(new RegExp(`<g class="node n-${id}">(.*?)</g>`, 's'))[1];

  it('draws the context box dotted, its title linking to Cockpit, and its components with a link to their folder and none to a page', () => {
    expect(page).toContain('nb nb-context');
    expect(page).toContain('<a href="service-cockpit.html"><text class="nb-t link"');
    expect(node('ctx-mcp')).toContain('href="https://github.com/o/r/tree/abc1234def5678/apps/api/src/mcp"');
    expect(node('ctx-mcp')).not.toContain('<a href="service-');
  });

  it('draws a line between the parts, and lists it with each file linked at its line', () => {
    expect(page).toContain('class="nl nl-ok f-client t-store');
    expect(page).toContain('href="https://github.com/o/r/blob/abc1234def5678/apps/app/src/widget/Client.kt#L1"');
  });

  it('says its lines are found by name, and that a common word can draw a false one', () => {
    expect(page).toContain('found by name');
    expect(page).toContain('A common word used as a name can draw a line that is not there');
  });

  it('carries no deviation tables, dialog or script', () => {
    expect(page).not.toContain('In the code, not in the design');
    expect(page).not.toContain('<dialog');
  });
});

describe('A design of a widget is checked as the rest of the description file is', () => {
  const read = (design) => readDescription({ design: { layers: [{ id: 'd', title: 'D', row: 0, items: [[chip('c', { in: 'a', files: ['x*'] })]] }], mayCall: {}, callers: [], noLine: [], ...design } }).design;

  it('reads how the lines are found and the extensions', () => {
    const value = read({ findLines: 'names', extensions: ['.kt'] });
    expect([value.findLines, value.extensions]).toEqual(['names', ['.kt']]);
  });

  it.each([
    { situation: 'lines are found a way it does not know', design: { findLines: 'guess' }, message: 'findLines must be one of' },
    { situation: 'a layer\'s spacing is not a number', design: { layers: [{ id: 'd', title: 'D', row: 0, subGap: 'wide', items: [[chip('c', { in: 'a', files: ['x*'] })]] }] }, message: 'subGap must be a number' },
    { situation: 'a caller reads no addresses and names no marker', design: { callers: [{ from: 'c', to: 'c', how: 'x', code: { folder: 'a' } }] }, message: 'code.marker is missing' },
  ])('fails the run when $situation', ({ design, message }) => {
    expect(() => read(design)).toThrow(ReadError);
    expect(() => read(design)).toThrow(message);
  });
});
