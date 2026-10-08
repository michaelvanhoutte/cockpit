import { describe, expect, it } from 'vitest';

import { buildModel } from '../../src/model.js';
import { renderHtml } from '../../src/render/html.js';
import { descriptionFile } from '../support/description.js';

const wrangler = JSON.stringify({ name: 'cockpit', d1_databases: [{ binding: 'DB', database_name: 'cockpit' }], env: { staging: { d1_databases: [{ binding: 'DB', database_name: 'cockpit-staging' }] } } });
const deploy = 'name: Deploy staging\non:\n  push:\n    branches: [main]\njobs:\n  go:\n    runs-on: ubuntu-latest\n    steps:\n      - run: pnpm wrangler deploy --env staging\n';
const page = (drawnFrom = { commit: 'abc1234def5678', date: '2026-10-08T13:03:04+02:00', repo: 'o/r' }) =>
  renderHtml(buildModel({ wrangler: { file: 'w.jsonc', text: wrangler }, workflows: [{ file: 'deploy-staging.yml', text: deploy }], description: descriptionFile(), ...drawnFrom }));

describe('The architecture page', () => {
  describe('the page names the commit and date it was drawn from', () => {
    it('states the commit, linked, and the date of that commit', () => {
      const html = page();
      expect(html).toContain('<b>abc1234</b>');
      expect(html).toContain('https://github.com/o/r/commit/abc1234def5678');
      expect(html).toContain('<b>2026-10-08</b>');
    });

    it('says so, rather than leaving the line out, when the checkout had no commit', () => {
      const html = page({ commit: null, date: null, repo: null });
      expect(html).toContain('commit <b>not known</b>');
      expect(html).toContain('commit dated <b>not known</b>');
    });
  });

  describe('the deployment is drawn as a diagram', () => {
    it('draws an environment per column with its resources, and an arrow from the workflow that deploys it', () => {
      const html = page();
      expect(html).toContain('<svg');
      expect(html).toContain('>staging</text>');
      expect(html).toContain('cockpit-staging');
      expect(html).toMatch(/class="t-hl"[^>]*>deploy-staging\.yml/);
      expect(html).toContain('marker-end="url(#arrow)"');
    });

    it('lays out a further environment as a further column, clear of the one before it', () => {
      const three = JSON.stringify({ name: 'w', d1_databases: [{ binding: 'DB', database_name: 'a' }], env: { staging: {}, qa: { vectorize: [{ binding: 'V', name: 'idx' }] } } });
      const html = renderHtml(buildModel({ wrangler: { file: 'w.jsonc', text: three }, workflows: [{ file: 'd.yml', text: deploy.replace('staging', 'qa') }], description: descriptionFile(), commit: null, date: null }));
      const columns = [...html.matchAll(/<rect class="worker" x="([\d.]+)" y="[\d.]+" width="([\d.]+)"/g)].map((each) => [Number(each[1]), Number(each[2])]);
      expect(columns).toHaveLength(3);
      for (let i = 1; i < columns.length; i += 1) expect(columns[i][0]).toBeGreaterThanOrEqual(columns[i - 1][0] + columns[i - 1][1]);
      expect(html).toContain('>vectorize</text>');
    });

    it('draws GitHub Pages with each published report at its path, and not at all without a Pages deploy', () => {
      const publish = 'name: Publish\non:\n  workflow_call:\njobs:\n  p:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/download-artifact@v4\n        with:\n          name: architecture-report\n          path: site/architecture/\n      - uses: actions/upload-pages-artifact@v3\n        with:\n          path: site/\n      - uses: actions/deploy-pages@v4\n';
      const draw = (workflows) => renderHtml(buildModel({ wrangler: { file: 'w.jsonc', text: wrangler }, workflows, description: descriptionFile(), commit: null, date: null }));
      const html = draw([{ file: 'publish.yml', text: publish }]);
      expect(html).toContain('GitHub Pages');
      expect(html).toContain('>/architecture/</text>');
      expect(html).toContain('>architecture-report</text>');
      expect(page()).not.toContain('GitHub Pages');
    });

    it('draws local development from the local environment, below GitHub', () => {
      const html = renderHtml(buildModel({ wrangler: { file: 'w.jsonc', text: JSON.stringify({ name: 'w', env: { local: { name: 'w-local', d1_databases: [{ binding: 'DB', database_name: 'dev' }] } } }) }, workflows: [{ file: 'd.yml', text: deploy }], description: descriptionFile(), commit: null, date: null }));
      expect(html).toContain('Local development');
      expect(html).toContain('>dev</text>');
    });
  });

  it('opens from disk: styles inline, no script, no remote address but links a reader follows', () => {
    const html = page();
    expect(html).toContain('<style>');
    expect(html).not.toContain('<script');
    expect(html).not.toMatch(/<link[^>]+href=/);
  });

  it('escapes what the repository wrote before putting it on the page', () => {
    const html = renderHtml({
      drawnFrom: { commit: null, date: null, repo: null },
      context: { cockpit: { name: 'x', summary: 'x', runs: '' }, people: [], services: [] },
      modules: { layers: [], sources: [], counts: { areas: 0, undescribed: 0, gone: 0, coreNamingASource: 0, connectorBreaches: 0 } },
      dependencies: { areas: [], cells: [], mutualPairs: [] },
      deployment: { environments: [{ name: 'x', kind: 'environment', worker: '<b>w</b>', resources: [], deployedBy: [] }], workflows: [] },
    });
    expect(html).toContain('&lt;b&gt;w&lt;/b&gt;');
  });

  it('follows the reader\'s light or dark setting', () => {
    expect(page()).toContain('prefers-color-scheme: light');
  });
});

const viewOf = (overrides, candidates = []) => renderHtml(buildModel({ wrangler: { file: 'w.jsonc', text: wrangler }, workflows: [], description: descriptionFile(overrides), candidates, commit: null, date: null }));
const texts = (html) => [...html.matchAll(/<text class="t-h"[^>]*>([^<]*)<\/text>/g)].map((each) => each[1]);

describe('Context', () => {
  describe('shows exactly the people and outside services the file declares', () => {
    const context = (people, services) => ({ cockpit: { name: 'Cockpit', summary: 'The thing' }, people, services });
    const entries = (...names) => names.map((name) => ({ name, detail: `${name} detail` }));

    it.each([
      { situation: 'two of each', people: ['Ann', 'Bo'], services: ['Acme', 'Globex'] },
      { situation: 'nobody and nothing', people: [], services: [] },
      { situation: 'more services than people', people: ['Ann'], services: ['A', 'B', 'C', 'D', 'E', 'F'] },
    ])('$situation', ({ people, services }) => {
      const html = viewOf({ context: context(entries(...people), entries(...services)) });
      const section = html.slice(html.indexOf('id="context"'), html.indexOf('id="modules"'));
      expect(texts(section)).toEqual(expect.arrayContaining([...people, ...services]));
      expect(texts(section).filter((each) => each !== 'Cockpit')).toHaveLength(people.length + services.length);
    });

    it('stacks a longer detail below its heading without overlapping the box under it', () => {
      const long = { name: 'Google', detail: 'sign-in, Gmail API, Drive, Calendar, and a good many more words than fit on a line of this width' };
      const html = viewOf({ context: context([], [long, { name: 'Next', detail: 'x' }]) });
      const boxes = [...html.matchAll(/<rect class="ext" x="[\d.]+" y="([\d.]+)" width="[\d.]+" height="([\d.]+)"/g)].map((each) => [Number(each[1]), Number(each[2])]);
      expect(boxes).toHaveLength(2);
      expect(boxes[1][0]).toBeGreaterThanOrEqual(boxes[0][0] + boxes[0][1]);
    });
  });
});

describe('Modules', () => {
  const described = (...paths) => ({ layers: [{ title: 'Layer', note: '', role: 'core', areas: paths.map((path) => ({ path, description: `${path} does its job` })) }] });
  const on = (path, files, role = 'core') => ({ path, package: false, role, files: Object.entries(files).map(([file, text]) => ({ file: `${path}/${file}`, text })) });

  describe('every area is drawn, with its wording or its mark', () => {
    it('shows an area’s description, marks one the file lacks as undescribed and one it lists but disk lacks as gone', () => {
      const html = viewOf(described('apps/api/src/a', 'apps/api/src/old'), [on('apps/api/src/a', { 'x.ts': '' }), on('apps/api/src/new', { 'x.ts': '' })]);
      expect(html).toContain('apps/api/src/a does its job');
      expect(html).toMatch(/class="ghost"/);
      expect(html).toContain('Gone: the description file');
      expect(html).toMatch(/class="undescribed"/);
      expect(html).toContain('Undescribed: not in the');
      expect(html).toContain('>Not in the description file</text>');
    });

    it('marks a core area naming a source with the files, and a connector breaching the rule with the import', () => {
      const html = viewOf(
        { layers: [{ title: 'L', note: '', role: 'core', areas: [{ path: 'apps/api/src/a', description: 'd' }, { path: 'packages/connectors/x', description: 'd', role: 'connector' }] }] },
        [on('apps/api/src/a', { 'gmail-check.ts': 'const gmail = 1;' }), on('packages/connectors/x', { 'src/a.ts': "import '@cockpit/shared';" }, 'connector')],
      );
      expect(html).toContain('Names Gmail in 1 file');
      expect(html).toContain('>gmail-check.ts</text>');
      expect(html).toContain('Imports @cockpit/shared');
      expect(html).toContain('>src/a.ts</text>');
      expect(html).not.toContain('Imports only the connector SDK');
    });

    it('says a clean connector imports only the SDK', () => {
      const html = viewOf({ layers: [{ title: 'L', note: '', role: 'connector', areas: [{ path: 'packages/connectors/x', description: 'd' }] }] }, [on('packages/connectors/x', { 'src/a.ts': 'export {}' }, 'connector')]);
      expect(html).toContain('Imports only the connector SDK');
      expect(html).toMatch(/class="clean"/);
    });

    it('shows the first few files under a mark and counts the rest', () => {
      const files = Object.fromEntries(Array.from({ length: 7 }, (_, index) => [`f${index}.ts`, 'gmail']));
      const html = viewOf(described('apps/api/src/a'), [on('apps/api/src/a', files)]);
      expect(html).toContain('Names Gmail in 7 files');
      expect(html).toContain('>+4 more</text>');
    });
  });

  describe('the layout is computed from the model, so nothing overlaps as areas grow', () => {
    const cards = (html) => [...html.slice(html.indexOf('id="modules"'), html.indexOf('id="deployment"')).matchAll(/<rect class="(?:box|breach|undescribed|ghost|clean)" x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/g)].map((each) => each.slice(1).map(Number));
    const overlap = ([ax, ay, aw, ah], [bx, by, bw, bh]) => ax < bx + bw && bx < ax + aw && ay < by + bh && by < ay + ah;

    it('places thirty areas of very different heights in rows of cards that never overlap each other', () => {
      const paths = Array.from({ length: 30 }, (_, index) => `apps/api/src/area-${index}`);
      const candidates = paths.map((path, index) => on(path, Object.fromEntries(Array.from({ length: index % 6 }, (_, at) => [`f${at}.ts`, index % 3 === 0 ? 'gmail claude code' : '']))));
      const placed = cards(viewOf(described(...paths), candidates));
      expect(placed).toHaveLength(30);
      for (let i = 0; i < placed.length; i += 1) for (let j = i + 1; j < placed.length; j += 1) expect(overlap(placed[i], placed[j])).toBe(false);
    });

    it('sizes the picture to hold the last row, however tall', () => {
      const html = viewOf(described(...Array.from({ length: 9 }, (_, index) => `apps/api/src/a${index}`)), []);
      const bottom = Math.max(...cards(html).map(([, y, , h]) => y + h));
      expect(Number(html.match(/<svg viewBox="0 0 1200 (\d+)"[^>]*aria-label="Module map/)[1])).toBeGreaterThan(bottom);
    });
  });
});

describe('Dependencies', () => {
  const on = (path, files) => ({ path, package: false, packageName: null, role: 'core', files: Object.entries(files).map(([file, text]) => ({ file: `${path}/${file}`, text })) });
  const named = (name) => ({ path: `apps/api/src/${name}`, name, description: 'd' });
  const drawn = (areas, candidates, overrides = {}) => viewOf({ layers: [{ title: 'L', note: '', role: 'core', areas }], ...overrides }, candidates);
  const section = (html) => html.slice(html.indexOf('id="deps"'), html.indexOf('id="deployment"'));

  describe('the matrix shows each area’s imports of the others, in the file’s order', () => {
    const html = drawn(
      [named('a'), named('b'), named('c')],
      [on('apps/api/src/a', { 'f.ts': "import '../b/g.js';\nimport '../c/h.js';" }), on('apps/api/src/b', { 'g.ts': "import '../a/f.js';" }), on('apps/api/src/c', { 'h.ts': 'x\ny\n' })],
    );

    it('has a rotated column header per area and a row per area carrying its line count', () => {
      const dependencies = section(html);
      expect([...dependencies.matchAll(/<th class="col"[^>]*><span>([^<]*)<\/span>/g)].map((each) => each[1])).toEqual(['a', 'b', 'c']);
      expect([...dependencies.matchAll(/<th class="row"[^>]*>(\w+) <span class="lines">(\d+)<\/span>/g)].map((each) => each.slice(1))).toEqual([['a', '2'], ['b', '1'], ['c', '2']]);
    });

    it('gives a mark its own colour per kind of dependency, with the count in the cell', () => {
      const dependencies = section(html);
      expect(dependencies).toMatch(/<td class="cyc" title="a imports b in 1 file[^"]*">1<\/td>/);
      expect(dependencies).toMatch(/<td class="dn" title="a imports c[^"]*">1<\/td>/);
      expect(dependencies).toContain('Depends on a layer below');
      expect(dependencies).toContain('Depends on a layer above');
    });

    it('names the mutual pairs in one line under the matrix', () => {
      expect(section(html)).toContain('1 pair of areas import each other: <code>a</code> with <code>b</code>.');
    });
  });

  it('groups the pairs by their first area, and says so when no two areas import each other', () => {
    const three = ['a', 'b', 'c'].map(named);
    const both = drawn(three, [on('apps/api/src/a', { 'f.ts': "import '../b/g.js';\nimport '../c/h.js';" }), on('apps/api/src/b', { 'g.ts': "import '../a/f.js';" }), on('apps/api/src/c', { 'h.ts': "import '../a/f.js';" })]);
    expect(section(both)).toContain('2 pairs of areas import each other: <code>a</code> with <code>b</code> and <code>c</code>.');
    expect(section(drawn(three, []))).toContain('No two areas import each other.');
  });

  it('mutes the area the file declares read by everything, and says why in the legend', () => {
    const html = drawn([named('a'), named('env')], [on('apps/api/src/a', { 'f.ts': "import '../env/e.js';" }), on('apps/api/src/env', { 'e.ts': '' })], { readByEveryone: ['apps/api/src/env'] });
    expect(section(html)).toMatch(/<td class="env" title="a imports env[^"]*">1<\/td>/);
    expect(section(html)).toContain('Muted: everything reads <code>env</code>');
  });

  it('puts the table in a container that scrolls on its own, and needs no script', () => {
    const html = drawn([named('a')], []);
    expect(section(html)).toMatch(/<div class="diagram">\s*<table class="dsm"/);
    expect(html).toMatch(/\.diagram \{[^}]*overflow-x: auto/);
    expect(html).not.toContain('<script');
  });
});
