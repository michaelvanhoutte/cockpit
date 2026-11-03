import { describe, expect, it } from 'vitest';

import { parseDescription } from '../../src/description.js';
import { ReadError } from '../../src/errors.js';
import { buildModel } from '../../src/model.js';
import { crossImports, sharedStores } from '../../src/services.js';
import { renderHtml } from '../../src/render/html.js';
import { renderLogicalPage, servicesOf } from '../../src/render/logical.js';
import { renderServicePages } from '../../src/render/services.js';
import { descriptionFile, readDescription, rulesFile } from '../support/description.js';

const chip = (id, extra = {}) => ({ id, name: id, ...extra });
const drawnFrom = { commit: 'abc1234def5678', date: '2026-10-08T13:03:04+02:00', repo: 'o/r' };

const folder = (path, files) => ({ path, package: false, packageName: null, role: 'core', files: Object.entries(files).map(([file, text]) => ({ file: `${path}/${file}`, text })) });

const COCKPIT_DESIGN = {
  layers: [
    { id: 'clients', title: 'Clients', kind: 'clients', row: 0, items: [[chip('web', { folders: ['apps/web/src'] }), chip('monitor', { kind: 'client' })]] },
    { id: 'api', title: 'API layer', href: 'cockpit-layer-api.html', row: 1, items: [[chip('http', { folders: ['apps/api/src/http'] })]] },
    { id: 'logic', title: 'Business logic', href: 'cockpit-layer-logic.html', row: 2, items: [[chip('accounts', { folders: ['apps/api/src/accounts'] }), chip('domain', { folders: ['apps/api/src/domain'] })]] },
    { id: 'data', title: 'Data', href: 'cockpit-layer-data.html', row: 3, items: [[chip('d1', { kind: 'store', href: 'db-register.html', sub: 'D1, all accounts', folders: ['apps/api/src/db'], marker: '\\benv\\.DB\\b', how: 'SQL' }), chip('r2', { kind: 'store', marker: '\\benv\\.FILES\\b', how: 'objects' })]] },
    { id: 'outside', title: 'Outside services', kind: 'outside', alignedWith: 'logic', items: [[chip('google', { kind: 'outside', marker: 'accounts\\.google\\.com', how: 'HTTPS' })]] },
  ],
  mayCall: { clients: ['api'], api: ['logic'], logic: ['data', 'outside'] },
  breaks: {},
  callers: [{ from: 'monitor', to: 'http', how: 'GET /v1/usage-records', code: { folder: 'apps/harness-monitor/src', marker: 'usage-records' } }],
  noLine: [{ folder: 'packages/shared', name: 'shared' }],
};

const MONITOR = {
  id: 'harness-monitor',
  name: 'Harness Monitor',
  intro: 'A second Worker, in `apps/harness-monitor`.',
  design: {
    layers: [
      { id: 'routes', title: 'Routes', row: 0, items: [[chip('entry', { folders: ['apps/harness-monitor/src'] })]] },
      { id: 'data', title: 'Data', row: 1, items: [[chip('mdb', { kind: 'store', marker: '\\.prepare\\(', how: 'SQL' })]] },
    ],
    mayCall: { routes: ['data'] },
    breaks: {},
    callers: [],
    noLine: [],
  },
};

const WORKFLOWS = [
  { file: 'deploy-production.yml', text: 'name: P\non:\n  workflow_dispatch:\njobs:\n  go:\n    runs-on: ubuntu-latest\n    steps:\n      - run: pnpm wrangler deploy\n' },
  { file: 'deploy-staging.yml', text: 'name: S\non:\n  push:\n    branches: [main]\njobs:\n  go:\n    runs-on: ubuntu-latest\n    steps:\n      - run: pnpm wrangler deploy --env staging\n' },
  { file: 'deploy-monitor.yml', text: 'name: M\non:\n  push:\n    branches: [main]\njobs:\n  go:\n    runs-on: ubuntu-latest\n    steps:\n      - run: pnpm wrangler deploy\n' },
  { file: 'widget-release.yml', text: 'name: W\non:\n  push:\n    tags: [widget-v*]\njobs:\n  go:\n    runs-on: ubuntu-latest\n    env:\n      KEY: ${{ secrets.WIDGET_KEYSTORE }}\n      TOKEN: ${{ secrets.GITHUB_TOKEN }}\n      PASSWORD: ${{ secrets.WIDGET_PASSWORD }}\n    steps:\n      - run: ./gradlew assembleRelease\n' },
];

const COCKPIT_CONFIG = JSON.stringify({
  name: 'cockpit',
  compatibility_date: '2026-01-01',
  vars: { MODE: 'live', SESSION_SECRET: 'hunter2-not-for-display' },
  d1_databases: [{ binding: 'DB', database_name: 'cockpit' }],
  queues: { producers: [{ binding: 'JOBS', queue: 'cockpit-jobs' }] },
  ai: { binding: 'AI' },
  env: {
    staging: { name: 'cockpit-staging', vars: { MODE: 'staging' }, d1_databases: [{ binding: 'DB', database_name: 'cockpit-staging' }] },
    local: { name: 'cockpit-local', d1_databases: [{ binding: 'DB', database_name: 'cockpit' }] },
  },
});
const COCKPIT_ENV = 'export interface Env {\n  DB: D1Database;\n  GOOGLE_CLIENT_SECRET: string;\n  SESSION_SECRET: string;\n  MODE: string;\n  OPEN_PORT: string;\n}\n';
const MONITOR_CONFIG = JSON.stringify({ name: 'harness-monitor', compatibility_date: '2026-02-02', vars: { REPO: 'o/r' }, d1_databases: [{ binding: 'DB', database_name: 'harness-monitor' }] });
const MONITOR_ENV = 'export interface Env {\n  DB: D1Database;\n  WRITE_KEY?: string;\n  REPO?: string;\n}\n';

const DEPLOYMENTS = [
  { service: 'cockpit', intro: 'Where it runs.', config: 'apps/api/wrangler.jsonc', bindings: 'apps/api/src/env.ts' },
  { service: 'harness-monitor', intro: 'Read from `apps/harness-monitor/wrangler.jsonc`.', config: 'apps/harness-monitor/wrangler.jsonc', bindings: 'apps/harness-monitor/src/worker.ts', shippedBy: { production: ['deploy-monitor.yml'] } },
  {
    service: 'android-widget',
    intro: 'How it reaches a phone.',
    environments: [
      { name: 'production', runsOn: 'a GitHub Release', workflow: 'widget-release.yml', secretsFrom: 'widget-release.yml', settings: { reads: 'Cockpit production' }, storage: [{ kind: 'On the phone', name: 'SharedPreferences' }] },
      { name: 'staging', runsOn: 'a phone', by: './gradlew assembleStagingDebug, by hand', settings: { reads: 'Cockpit staging' }, storage: [{ kind: 'On the phone', name: 'SharedPreferences' }] },
    ],
  },
];
const WIDGET = { id: 'android-widget', name: 'Android widget', intro: 'The widget.', design: { ...MONITOR.design, layers: [{ id: 'widget', title: 'Android widget', kind: 'service', row: 0, items: [[chip('ui', { folders: ['apps/web/src'] })]] }], mayCall: {} } };

const SERVICE_MAP = {
  clients: [{ id: 'people', name: 'People', sub: 'a browser' }],
  services: [
    { id: 'harness-monitor', share: 0.4, items: [[{ name: 'Routes', href: 'service-harness-monitor.html' }]] },
    { id: 'cockpit', share: 0.6, items: [[{ name: 'Web app', href: 'service-cockpit.html' }], [{ name: 'Business logic', href: 'cockpit-layer-logic.html' }], [{ name: 'Data', kind: 'store', href: 'cockpit-layer-data.html' }]] },
  ],
  calls: [{ from: 'people', to: 'cockpit', how: 'web app' }, { from: 'harness-monitor', to: 'cockpit', how: 'its API', foundBy: 'monitor' }],
  owns: { cockpit: { folders: ['apps/api', 'apps/web', 'packages'], packages: ['@cockpit/'] }, 'harness-monitor': { folders: ['apps/harness-monitor'], packages: ['@harness-monitor/'] } },
};

/** A model of two services, each with files of its own; `files` replaces the text of any file named. */
function modelOf({ files = {}, monitorConfig = MONITOR_CONFIG, deployments = DEPLOYMENTS, monitorDesign = MONITOR, off = {} } = {}) {
  const on = (path, defaults) => ({ ...defaults, ...(files[path] ?? {}) });
  const design = { ...COCKPIT_DESIGN, ...off };
  return buildModel({
    wrangler: { file: 'apps/api/wrangler.jsonc', text: COCKPIT_CONFIG },
    workflows: WORKFLOWS,
    description: descriptionFile({ design, otherServices: [monitorDesign, WIDGET], deployments, serviceMap: SERVICE_MAP }),
    rules: rulesFile({ design, otherServices: [monitorDesign, WIDGET], deployments, serviceMap: SERVICE_MAP }),
    candidates: [
      folder('apps/web/src', on('apps/web/src', {})),
      folder('apps/api/src/http', on('apps/api/src/http', { 'app.ts': "import '../accounts/store.js';" })),
      folder('apps/api/src/accounts', on('apps/api/src/accounts', { 'store.ts': "import '../domain/item.js';" })),
      folder('apps/api/src/domain', on('apps/api/src/domain', { 'item.ts': '' })),
      folder('apps/api/src/db', on('apps/api/src/db', {})),
      folder('packages/shared', on('packages/shared', { 'index.ts': '' })),
      folder('apps/harness-monitor/src', on('apps/harness-monitor/src', { 'worker.ts': 'db.prepare(q);' })),
    ],
    callerCode: { 'apps/harness-monitor/src': [{ file: 'apps/harness-monitor/src/worker.ts', text: `${on('apps/harness-monitor/src', { 'worker.ts': 'db.prepare(q);' })['worker.ts']}\nfetch('/v1/usage-records');` }] },
    deploymentFiles: { 'apps/api/wrangler.jsonc': COCKPIT_CONFIG, 'apps/api/src/env.ts': COCKPIT_ENV, 'apps/harness-monitor/wrangler.jsonc': monitorConfig, 'apps/harness-monitor/src/worker.ts': MONITOR_ENV },
    ...drawnFrom,
  });
}

const stripped = (html) => html.replace(/<style>[\s\S]*?<\/style>/g, '');

describe('Services reach each other only through each other\'s API', () => {
  const owns = SERVICE_MAP.owns;
  const check = (file, text) => crossImports({ owns, files: [{ file, text }], extensions: ['.ts'] });

  it.each([
    { situation: 'a Monitor file imports a Cockpit package', file: 'apps/harness-monitor/src/a.ts', text: "import { x } from '@cockpit/shared';", expected: [['harness-monitor', 'cockpit', 1]] },
    { situation: 'a Monitor file imports Cockpit\'s code by a relative path', file: 'apps/harness-monitor/src/a.ts', text: "const y = 1;\nimport { x } from '../../api/src/env.js';", expected: [['harness-monitor', 'cockpit', 2]] },
    { situation: 'a Cockpit file imports the Monitor', file: 'apps/api/src/a.ts', text: "import { x } from '../../harness-monitor/src/store.js';", expected: [['cockpit', 'harness-monitor', 1]] },
    { situation: 'a file imports its own service and a third-party package', file: 'apps/harness-monitor/src/a.ts', text: "import './b.js';\nimport { z } from 'zod';", expected: [] },
    { situation: 'a relative path lands on the other service folder itself', file: 'apps/harness-monitor/src/a.ts', text: "import { x } from '../../api';", expected: [['harness-monitor', 'cockpit', 1]] },
    { situation: 'a package that only shares the start of another service package name', file: 'apps/harness-monitor/src/a.ts', text: "import { x } from '@cockpit-extras/thing';", expected: [] },
    { situation: 'a comment mentions another service\'s package', file: 'apps/harness-monitor/src/a.ts', text: "// import '@cockpit/shared'\nexport {};", expected: [] },
  ])('$situation', ({ file, text, expected }) => {
    const found = check(file, text);
    expect(found.map((each) => [each.from, each.to, each.line])).toEqual(expected);
    expect(found.every((each) => each.file === file)).toBe(true);
  });

  it('is red on the services page, naming the file at its line', () => {
    const model = modelOf({ files: { 'apps/harness-monitor/src': { 'worker.ts': "db.prepare(q);\nimport { x } from '@cockpit/shared';" } } });
    const page = renderServicePages(model)['services.html'];
    expect(model.serviceMap.cross.imports).toMatchObject([{ from: 'harness-monitor', to: 'cockpit', file: 'apps/harness-monitor/src/worker.ts', line: 2 }]);
    expect(page).toContain('<span class="bad">1 file imports another service\'s code:</span>');
    expect(page).toContain('href="https://github.com/o/r/blob/abc1234def5678/apps/harness-monitor/src/worker.ts#L2"');
    expect(page).toContain('<path class="nl nl-bad');
  });

  it('lists a store both configs bind as shared, in red', () => {
    const both = JSON.stringify({ name: 'harness-monitor', d1_databases: [{ binding: 'DB', database_name: 'cockpit' }] });
    const model = modelOf({ monitorConfig: both });
    expect(sharedStores(model.deployments)).toEqual([{ kind: 'D1 database', name: 'cockpit', services: ['cockpit', 'harness-monitor'] }]);
    expect(renderServicePages(model)['services.html']).toContain('<span class="bad">Shared stores: D1 database cockpit</span>');
  });

  it('says so in two green sentences when no file imports another service and no store is shared', () => {
    const page = renderServicePages(modelOf())['services.html'];
    expect(page).toContain('<span class="ok">No file imports another service\'s code.</span>');
    expect(page).toContain('<span class="ok">No store is used by two services.</span>');
    expect(page).not.toContain('class="nl nl-bad');
  });
});

describe('Each service\'s badge counts its red lines and opens them', () => {
  it('says "N off the design", linking to the service\'s table of red lines', () => {
    const model = modelOf({ files: { 'apps/api/src/http': { 'a0.ts': 'await env.DB.prepare(q);', 'a1.ts': 'await env.FILES.get(k);' } } });
    expect(model.serviceMap.boxes.find((box) => box.id === 'cockpit').off).toBe(2);
    const page = renderServicePages(model)['services.html'];
    expect(page).toContain('<a href="service-cockpit.html#off"><rect class="nb-badge"');
    expect(page).toContain('>2 off the design</text>');
  });

  it('counts only the red lines, so one accepted for its files is not in the number', () => {
    const files = { 'apps/api/src/http': { 'a0.ts': 'await env.DB.prepare(q);', 'a1.ts': 'await env.FILES.get(k);' } };
    const accepted = [{ from: 'http', to: 'd1', files: ['apps/api/src/http/a0.ts'], reason: 'Because.' }];
    const model = modelOf({ files, off: { accepted } });
    expect(model.logical.accepted).toHaveLength(1);
    expect(model.serviceMap.boxes.find((box) => box.id === 'cockpit').off).toBe(1);
    expect(renderServicePages(model)['services.html']).toContain('>1 off the design</text>');
  });

  it('draws no badge on a service with no red line', () => {
    const model = modelOf();
    expect(model.serviceMap.boxes.map((box) => box.off)).toEqual([0, 0]);
    expect(renderServicePages(model)['services.html']).not.toContain('off the design</text>');
  });
});

describe('A service\'s Deployment tab has one column per environment its config declares', () => {
  const pageOf = (model, file) => renderServicePages(model)[file];
  const headings = (html) => [...html.match(/<table class="flows">[\s\S]*?<\/tr>/)[0].matchAll(/<th>([^<]*)<\/th>/g)].map((each) => each[1]).filter(Boolean);

  it('has production, staging and local for a config with all three, each with what ships it, its bindings and its secrets by name', () => {
    const model = modelOf();
    const html = pageOf(model, 'service-cockpit-deployment.html');
    expect(headings(html)).toEqual(['production', 'staging', 'local']);
    expect(html).toContain('<a class="gh" href="https://github.com/o/r/blob/abc1234def5678/.github/workflows/deploy-production.yml" target="_blank" rel="noopener"><code>.github/workflows/deploy-production.yml</code></a>, by hand');
    expect(html).toContain('<code>.github/workflows/deploy-staging.yml</code></a>, every merge');
    expect(html).toContain('pnpm dev');
    expect(html).toContain('<span class="chip">D1 database DB → cockpit-staging</span>');
    expect(html).toContain('<span class="chip q">Queue, producer JOBS → cockpit-jobs</span>');
    expect(html).toContain('<span class="chip o">Workers AI AI</span>');
    expect(html).toContain('<span class="chip s">GOOGLE_CLIENT_SECRET</span>');
    expect(html).toContain('<h2>Each environment</h2>');
  });

  it('opens Cockpit\'s tab on the report\'s own deployment drawing', () => {
    const model = modelOf();
    const html = pageOf(model, 'service-cockpit-deployment.html');
    expect(html).toMatch(/<div class="diagram full"><svg viewBox="0 0 [\d.]+ [\d.]+" style="width:[\d.]+px;height:[\d.]+px"/);
  });

  it('has one column for a config with production only, shipped by the workflow the description names', () => {
    const html = pageOf(modelOf(), 'service-harness-monitor-deployment.html');
    expect(headings(html)).toEqual(['production']);
    expect(html).toContain('<code>.github/workflows/deploy-monitor.yml</code></a>');
    expect(html).not.toContain('deploy-production.yml');
    expect(html).not.toContain('<h2>Each environment</h2>');
  });

  it('has production and staging for the widget: its release workflow, and by hand', () => {
    const html = pageOf(modelOf(), 'service-android-widget-deployment.html');
    expect(headings(html)).toEqual(['production', 'staging']);
    expect(html).toContain('<code>.github/workflows/widget-release.yml</code></a>, a tag push');
    expect(html).toContain('./gradlew assembleStagingDebug, by hand');
    expect(html).toContain('<span class="chip s">WIDGET_KEYSTORE</span>');
    expect(html).toContain('<span class="chip s">WIDGET_PASSWORD</span>');
    expect(html).not.toContain('GITHUB_TOKEN');
  });

  it('never shows a secret\'s value, only its name, even for a setting named like one', () => {
    const model = modelOf();
    for (const html of Object.values(renderServicePages(model))) expect(html).not.toContain('hunter2');
    const cockpit = pageOf(model, 'service-cockpit-deployment.html');
    expect(cockpit).toContain('<code>SESSION_SECRET</code> (set)');
    expect(cockpit).toContain('<code>MODE</code> live');
    expect(JSON.stringify(model.deployments)).not.toContain('hunter2');
  });

  it('switches between the two tabs on a service\'s pages, and the logical page links its Deployment tab', () => {
    const model = modelOf();
    const [cockpit] = servicesOf(model);
    const logical = renderLogicalPage(model, cockpit);
    expect(logical).toContain('<nav class="switch"><a href="service-cockpit-design.html">Design</a><span class="on">Logical</span><a href="service-cockpit-deployment.html">Deployment</a></nav>');
    expect(pageOf(model, 'service-cockpit-deployment.html')).toContain('<nav class="switch"><a href="service-cockpit-design.html">Design</a><a href="service-cockpit.html">Logical</a><span class="on">Deployment</span></nav>');
  });

  it('links no services page from a trail when the description has no serviceMap', () => {
    const model = { ...modelOf(), serviceMap: undefined };
    const pages = renderServicePages(model);
    expect(pages['services.html']).toBeUndefined();
    for (const html of [...Object.values(pages), renderLogicalPage(model, servicesOf(model)[0])]) expect(html).not.toContain('href="services.html"');
  });

  it('leaves a service out of the model when its config is not in an earlier commit', () => {
    const model = buildModel({ ...{ wrangler: { file: 'w', text: COCKPIT_CONFIG }, workflows: WORKFLOWS }, description: descriptionFile({ deployments: [DEPLOYMENTS[0]] }), deploymentFiles: { 'apps/api/wrangler.jsonc': null, 'apps/api/src/env.ts': null }, ...drawnFrom });
    expect(model.deployments).toEqual([]);
  });
});

describe('A layer page shows only that layer\'s folders and the imports between them', () => {
  const pages = (files) => renderServicePages(modelOf({ files }));

  it('has Business logic\'s folders on its Modules tab, each folder marked ↗ and opening it on GitHub', () => {
    const html = pages()['cockpit-layer-logic.html'];
    expect([...html.matchAll(/data-area="([^"]+)"/g)].map((each) => each[1]).sort()).toEqual(['apps/api/src/accounts', 'apps/api/src/domain']);
    expect(html).toContain('<a class="code" href="https://github.com/o/r/tree/abc1234def5678/apps/api/src/accounts" target="_blank" rel="noopener">');
    expect(html.match(/>↗<\/text>/g)).toHaveLength(2);
    expect(html).toContain('<nav class="switch"><span class="on">Modules</span><a href="cockpit-layer-logic-dependencies.html">Dependencies</a></nav>');
    expect(html).toContain('<a href="services-design.html">Services</a> › <a href="service-cockpit-design.html">Cockpit</a> › Business logic');
  });

  it('has the same imports as a matrix on its Dependencies tab', () => {
    const html = pages()['cockpit-layer-logic-dependencies.html'];
    const rows = [...html.matchAll(/<th class="row" scope="row" title="([^"]+)">/g)].map((each) => each[1]);
    expect(rows).toEqual(['apps/api/src/accounts', 'apps/api/src/domain']);
    expect(html).toMatch(/<th class="row" scope="row" title="apps\/api\/src\/accounts">[^<]*<span class="lines">[\d,]+<\/span><\/th><td class="self"><\/td><td class="dn"[^>]*>1<\/td>/);
    expect(html).toContain('<nav class="switch"><a href="cockpit-layer-logic.html">Modules</a><span class="on">Dependencies</span></nav>');
  });

  it('leaves an import out of the layer off both tabs', () => {
    // The API layer's http imports accounts, and accounts imports a file in the API layer: neither crosses the cut.
    const out = pages({ 'apps/api/src/accounts': { 'store.ts': "import '../domain/item.js';\nimport '../http/app.js';" } });
    for (const file of ['cockpit-layer-logic.html', 'cockpit-layer-logic-dependencies.html']) {
      expect(out[file]).not.toContain('apps/api/src/http');
      expect(out[file]).not.toContain('>http<');
    }
    expect(out['cockpit-layer-logic-dependencies.html'].match(/<td class="(dn|up)/g)).toHaveLength(1);
    expect(out['cockpit-layer-api.html']).toContain('data-area="apps/api/src/http"');
  });

  it('has a card per store on the Data page, a database\'s card opening its table page, and who uses it', () => {
    const html = pages({ 'apps/api/src/accounts': { 'store.ts': 'await env.DB.prepare(q);' } })['cockpit-layer-data.html'];
    expect(html).toContain('<a href="db-register.html" class="card"><h4>d1</h4><p>D1, all accounts</p><p class="meta">Open its tables. Used by accounts</p></a>');
    expect(html).toMatch(/<div class="card"><h4>r2<\/h4><p><\/p><p class="meta">Used by no component the code names<\/p><\/div>/);
    expect(html).not.toContain('class="switch"');
  });

  it('writes a page for a layer that names one, and for no other', () => {
    const files = Object.keys(pages());
    expect(files).toEqual(expect.arrayContaining(['cockpit-layer-api.html', 'cockpit-layer-api-dependencies.html', 'cockpit-layer-logic.html', 'cockpit-layer-logic-dependencies.html', 'cockpit-layer-data.html']));
    expect(files).not.toContain('cockpit-layer-clients.html');
    expect(files.filter((file) => file.startsWith('service-android-widget'))).toEqual(['service-android-widget-deployment.html']);
  });
});

describe('The services page is linked from the report, and its crumbs lead back', () => {
  it('adds one link to the report\'s header, and none where the description has no services map', () => {
    const model = modelOf();
    expect(renderHtml(model)).toContain('<span><a href="services-design.html"><b>Services &rarr;</b></a></span>');
    expect(renderHtml({ ...model, serviceMap: null })).not.toContain('services.html');
  });

  it('draws a box per service, each opening its page, and the lines between them', () => {
    const html = renderServicePages(modelOf())['services.html'];
    expect(html).toContain('<a href="service-cockpit-design.html"><text class="nb-t link"');
    expect(html).toContain('<a href="service-harness-monitor-design.html"><text class="nb-t link"');
    expect(html).toContain('>its API</text>');
    expect(html).toContain('<a href="cockpit-layer-logic.html">');
    expect(stripped(html)).toContain('<a href="index.html">Architecture</a> › Services');
  });

  it('lists what deploys on its own: the workflow, the environments and the stores of each service', () => {
    const html = renderServicePages(modelOf())['services.html'];
    const rows = [...html.match(/<h2>What deploys on its own<\/h2>[\s\S]*$/)[0].matchAll(/<tr><td>(.*?)<\/td><td>(.*?)<\/td><td>(.*?)<\/td><td>(.*?)<\/td><\/tr>/g)].map((each) => each.slice(1));
    expect(rows).toHaveLength(3);
    expect(rows[1][0]).toContain('>Harness Monitor</a>');
    expect(rows[1][1]).toContain('deploy-monitor.yml');
    expect(rows[1][2]).toBe('production');
    expect(rows[2][0]).toContain('Android widget, part of Cockpit');
    expect(rows[2][2]).toBe('production, staging');
  });

  it('makes a path written in a page\'s prose a link to it on GitHub at the commit, and leaves a page without a repository alone', () => {
    const html = renderServicePages(modelOf())['service-harness-monitor-deployment.html'];
    expect(html).toContain('<a class="gh" href="https://github.com/o/r/blob/abc1234def5678/apps/harness-monitor/wrangler.jsonc" target="_blank" rel="noopener"><code>apps/harness-monitor/wrangler.jsonc</code></a>');
    const bare = renderServicePages({ ...modelOf(), drawnFrom: { commit: null, date: null, repo: null } })['service-harness-monitor-deployment.html'];
    expect(bare).toContain('<code>apps/harness-monitor/wrangler.jsonc</code>');
    expect(bare).not.toContain('github.com');
  });
});

describe('The services sections of the description file are checked like the rest of it', () => {
  const read = (overrides) => readDescription(overrides);

  it.each([
    { situation: 'a deployment names a service the file does not describe', overrides: { deployments: [{ service: 'ghost', config: 'a.jsonc' }] } },
    { situation: 'a deployment names neither a config nor environments', overrides: { deployments: [{ service: 'cockpit' }] } },
    { situation: 'a hand-listed environment names neither a workflow nor words for what ships it', overrides: { deployments: [{ service: 'cockpit', environments: [{ name: 'production', runsOn: 'a phone' }] }] } },
    { situation: 'a call names something that is neither a client nor a service', overrides: { serviceMap: { ...SERVICE_MAP, calls: [{ from: 'ghost', to: 'cockpit', how: 'x' }] }, design: COCKPIT_DESIGN } },
    { situation: 'a call is looked for in a caller the design does not have', overrides: { serviceMap: { ...SERVICE_MAP, calls: [{ from: 'people', to: 'cockpit', how: 'x', foundBy: 'ghost' }] }, design: COCKPIT_DESIGN } },
    { situation: 'a box is for a service the file does not describe', overrides: { serviceMap: { ...SERVICE_MAP, services: [{ id: 'ghost', items: [[{ name: 'x' }]] }] } } },
  ])('fails the run when $situation', ({ overrides }) => {
    expect(() => read(overrides)).toThrow(ReadError);
  });

  it('reads both sections as empty when the file has neither', () => {
    expect(read({})).toMatchObject({ deployments: [], serviceMap: null });
  });
});
