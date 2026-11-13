import { describe, expect, it } from 'vitest';

import { buildModel } from '../../src/model.js';
import { renderDiagram } from '../../src/render/diagram.js';
import { atNaturalSize } from '../../src/render/svg.js';
import { renderWholeAppPages } from '../../src/render/services.js';
import { descriptionFile } from '../support/description.js';

const wrangler = JSON.stringify({ name: 'cockpit', d1_databases: [{ binding: 'DB', database_name: 'cockpit' }], env: { staging: { d1_databases: [{ binding: 'DB', database_name: 'cockpit-staging' }] } } });
const deploy = 'name: Deploy staging\non:\n  push:\n    branches: [main]\njobs:\n  go:\n    runs-on: ubuntu-latest\n    steps:\n      - run: pnpm wrangler deploy --env staging\n';
const modelOf = (overrides = {}, candidates = [], { workflows = [], config = wrangler } = {}) =>
  buildModel({ wrangler: { file: 'w.jsonc', text: config }, workflows, description: descriptionFile(overrides), candidates, commit: null, date: null });

describe('The deployment drawing Cockpit\'s Deployment tab embeds', () => {
  const drawn = (workflows = [{ file: 'deploy-staging.yml', text: deploy }], config = wrangler) => renderDiagram(modelOf({}, [], { workflows, config }));

  it('draws an environment per column with its resources, and an arrow from the workflow that deploys it', () => {
    const svg = drawn();
    expect(svg).toContain('>staging</text>');
    expect(svg).toContain('cockpit-staging');
    expect(svg).toMatch(/class="t-hl"[^>]*>deploy-staging\.yml/);
    expect(svg).toContain('marker-end="url(#arrow)"');
  });

  it('lays out a further environment as a further column, clear of the one before it', () => {
    const three = JSON.stringify({ name: 'w', d1_databases: [{ binding: 'DB', database_name: 'a' }], env: { staging: {}, qa: { vectorize: [{ binding: 'V', name: 'idx' }] } } });
    const svg = drawn([{ file: 'd.yml', text: deploy.replace('staging', 'qa') }], three);
    const columns = [...svg.matchAll(/<rect class="worker" x="([\d.]+)" y="[\d.]+" width="([\d.]+)"/g)].map((each) => [Number(each[1]), Number(each[2])]);
    expect(columns).toHaveLength(3);
    for (let i = 1; i < columns.length; i += 1) expect(columns[i][0]).toBeGreaterThanOrEqual(columns[i - 1][0] + columns[i - 1][1]);
    expect(svg).toContain('>vectorize</text>');
  });

  it('draws GitHub Pages with each published report at its path, and not at all without a Pages deploy', () => {
    const publish = 'name: Publish\non:\n  workflow_call:\njobs:\n  p:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/download-artifact@v4\n        with:\n          name: architecture-report\n          path: site/architecture/\n      - uses: actions/upload-pages-artifact@v3\n        with:\n          path: site/\n      - uses: actions/deploy-pages@v4\n';
    const svg = drawn([{ file: 'publish.yml', text: publish }]);
    expect(svg).toContain('GitHub Pages');
    expect(svg).toContain('>/architecture/</text>');
    expect(svg).toContain('>architecture-report</text>');
    expect(drawn()).not.toContain('GitHub Pages');
  });

  it('draws local development from the local environment, below GitHub', () => {
    const svg = drawn([{ file: 'd.yml', text: deploy }], JSON.stringify({ name: 'w', env: { local: { name: 'w-local', d1_databases: [{ binding: 'DB', database_name: 'dev' }] } } }));
    expect(svg).toContain('Local development');
    expect(svg).toContain('>dev</text>');
  });

  it('escapes what the repository wrote before putting it on the page', () => {
    const model = { ...modelOf(), deployment: { environments: [{ name: 'x', kind: 'environment', worker: '<b>w</b>', resources: [], deployedBy: [] }], workflows: [] } };
    expect(renderDiagram(model)).toContain('&lt;b&gt;w&lt;/b&gt;');
  });

  it('is drawn at the size of its own viewBox when the page asks for it', () => {
    const svg = atNaturalSize(drawn());
    const [, width, height] = svg.match(/<svg viewBox="0 0 ([\d.]+) ([\d.]+)" style="width:([\d.]+)px;height:([\d.]+)px"/);
    expect(svg).toContain(`style="width:${width}px;height:${height}px"`);
    expect(() => atNaturalSize('<svg>')).toThrow('did not start with a sized <svg>');
  });
});

describe('Modules', () => {
  const described = (...paths) => ({ layers: [{ title: 'Layer', note: '', role: 'core', areas: paths.map((path) => ({ path, description: `${path} does its job` })) }] });
  const on = (path, files, role = 'core') => ({ path, package: false, role, files: Object.entries(files).map(([file, text]) => ({ file: `${path}/${file}`, text })) });
  const viewOf = (overrides, candidates = []) => renderWholeAppPages(modelOf(overrides, candidates))['modules.html'];

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

    it('leaves out a file that only mentions a source and marks a connector breaching the rule with the import', () => {
      const html = viewOf(
        { layers: [{ title: 'L', note: '', role: 'core', areas: [{ path: 'apps/api/src/a', description: 'd' }, { path: 'packages/connectors/x', description: 'd', role: 'connector' }] }] },
        [on('apps/api/src/a', { 'labels.ts': "const gmail = 'Gmail';" }), on('packages/connectors/x', { 'src/a.ts': "import '@cockpit/shared';" }, 'connector')],
      );
      expect(html).not.toContain('Names Gmail');
      expect(html).not.toContain('labels.ts');
      expect(html).not.toContain('class="edge-core"');
      expect(html).toContain('Imports @cockpit/shared');
      expect(html).toContain('>src/a.ts</text>');
      expect(html).not.toContain('Imports only the connector SDK');
    });

    it('says a clean connector imports only the SDK', () => {
      const html = viewOf({ layers: [{ title: 'L', note: '', role: 'connector', areas: [{ path: 'packages/connectors/x', description: 'd' }] }] }, [on('packages/connectors/x', { 'src/a.ts': 'export {}' }, 'connector')]);
      expect(html).toContain('Imports only the connector SDK');
      expect(html).toMatch(/class="clean"/);
    });

    it('shows the first few files under a breach and counts the rest', () => {
      const files = Object.fromEntries(Array.from({ length: 7 }, (_, index) => [`f${index}.ts`, "import '@cockpit/shared';"]));
      const html = viewOf({ layers: [{ title: 'L', note: '', role: 'connector', areas: [{ path: 'packages/connectors/x', description: 'd' }] }] }, [on('packages/connectors/x', files, 'connector')]);
      expect(html).toContain('>+4 more</text>');
    });

    it('draws a connector box for each source, with a dashed red line to each core area holding its files, and the one Worker round it all', () => {
      const html = viewOf(
        { layers: [{ title: 'L', note: '', role: 'core', areas: [{ path: 'apps/api/src/a', description: 'd' }] }], sources: [{ id: 'gmail', name: 'Gmail', words: ['gmail'] }] },
        [on('apps/api/src/a', { 'gmail.ts': '', 'gmail-check.ts': '' })],
      );
      expect(html).toMatch(/<rect class="ghost" data-connector="gmail"/);
      expect(html).toContain('No package of its own');
      expect(html).toContain('>2 files</text>');
      expect(html).toContain('One release: the Worker cockpit');
    });
  });

  describe('the layout is computed from the model, so nothing overlaps as areas grow', () => {
    const cards = (html) => [...html.matchAll(/<rect class="(?:box|breach|undescribed|ghost|clean)" data-area="[^"]*" x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/g)].map((each) => each.slice(1).map(Number));
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
      expect(Number(html.match(/<svg viewBox="0 0 \d+ (\d+)"[^>]*aria-label="Module map/)[1])).toBeGreaterThan(bottom);
    });
  });
});

describe('Dependencies', () => {
  const on = (path, files) => ({ path, package: false, packageName: null, role: 'core', files: Object.entries(files).map(([file, text]) => ({ file: `${path}/${file}`, text })) });
  const named = (name) => ({ path: `apps/api/src/${name}`, name, description: 'd' });
  const drawn = (areas, candidates, overrides = {}) => renderWholeAppPages(modelOf({ layers: [{ title: 'L', note: '', role: 'core', areas }], ...overrides }, candidates))['modules-dependencies.html'];

  describe('the matrix shows each area’s imports of the others, in the file’s order', () => {
    const html = drawn(
      [named('a'), named('b'), named('c')],
      [on('apps/api/src/a', { 'f.ts': "import '../b/g.js';\nimport '../c/h.js';" }), on('apps/api/src/b', { 'g.ts': "import '../a/f.js';" }), on('apps/api/src/c', { 'h.ts': 'x\ny\n' })],
    );

    it('has a rotated column header per area and a row per area carrying its line count', () => {
      expect([...html.matchAll(/<th class="col"[^>]*><span>([^<]*)<\/span>/g)].map((each) => each[1])).toEqual(['a', 'b', 'c']);
      expect([...html.matchAll(/<th class="row"[^>]*>(\w+) <span class="lines">(\d+)<\/span>/g)].map((each) => each.slice(1))).toEqual([['a', '2'], ['b', '1'], ['c', '2']]);
    });

    it('shows a cycle’s upward half red and its downward half outlined, with the count in the cell', () => {
      expect(html).toMatch(/<td class="up" title="b imports a in 1 file[^"]*">1<\/td>/);
      expect(html).toMatch(/<td class="dn part" title="a imports b in 1 file[^"]*">1<\/td>/);
      expect(html).toMatch(/<td class="dn" title="a imports c[^"]*">1<\/td>/);
      expect(html).toContain('Imports an area above, against the order');
      expect(html).toMatch(/\.dsm td\.up \{[^}]*background: var\(--red\)/);
      expect(html).toMatch(/\.dsm td\.part \{[^}]*outline: 2px solid var\(--red\)/);
    });

    it('names the cycles in one line under the matrix', () => {
      expect(html).toContain('1 pair of areas import each other: <code>a</code> with <code>b</code>.');
    });

    it('says the order is exact, and that it could not decide a cycle of equal halves', () => {
      expect(html).toContain('The order is exact: every order of the 3 areas was weighed, up to 22.');
      expect(html).toContain('The order could not decide <code>a</code> and <code>b</code>');
    });
  });

  it('says the order is approximate when there are more areas than the exact search weighs', () => {
    const names = Array.from({ length: 23 }, (_, at) => `m${at}`);
    const html = drawn(names.map(named), names.map((name) => on(`apps/api/src/${name}`, { 'x.ts': 'export {}' })));
    expect(html).toContain('The order is approximate: 23 areas are more than the 22 an exact search weighs');
  });

  it('mutes the area the file declares read by everything, and says why in the legend', () => {
    const html = drawn([named('a'), named('env')], [on('apps/api/src/a', { 'f.ts': "import '../env/e.js';" }), on('apps/api/src/env', { 'e.ts': '' })], { readByEveryone: ['apps/api/src/env'] });
    expect(html).toMatch(/<td class="env" title="a imports env[^"]*">1<\/td>/);
    expect(html).toContain('Muted: everything reads <code>env</code>');
  });

  it('puts the table in a container that scrolls on its own, and needs no script', () => {
    const html = drawn([named('a')], []);
    expect(html).toMatch(/<div class="diagram"><table class="dsm"/);
    expect(html).toMatch(/\.diagram \{[^}]*overflow-x: auto/);
    expect(html).not.toContain('<script');
  });
});

describe('The Modules page opens from disk and follows the reader’s setting', () => {
  const html = renderWholeAppPages(modelOf())['modules.html'];

  it('has its styles inline, no script and no remote address but links a reader follows', () => {
    expect(html).toContain('<style>');
    expect(html).not.toContain('<script');
    expect(html).not.toMatch(/<link[^>]+href=/);
  });

  it('carries both palettes on the page and forces neither', () => {
    const styles = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
    const dark = styles.match(/@media \(prefers-color-scheme: dark\) \{\s*:root \{([^}]*)\}/)?.[1] ?? '';
    const light = styles.match(/:root \{([^}]*)\}/)?.[1] ?? '';
    expect(html).toContain('<meta name="color-scheme" content="light dark">');
    expect(light).toContain('color-scheme: light dark');
    expect(dark.match(/--bg: (#\w+)/)?.[1]).not.toBe(light.match(/--bg: (#\w+)/)?.[1]);
    expect(html).not.toContain('data-theme');
  });
});
