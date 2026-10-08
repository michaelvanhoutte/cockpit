/**
 * The whole pipeline, argv in and real files out, over a fixture repository and
 * over this repository's own checkout.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { main } from '../../src/cli.js';
import { descriptionFile } from '../support/description.js';

const checkout = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const dirs = [];
const tmp = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'architecture-'));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const WORKFLOW = 'name: Tests\non:\n  pull_request:\njobs:\n  go:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n';

/** A repository holding just what the generator reads, with the given text for each file. */
function fixture({ config = '{ // comment\n "name": "w", }\n', workflows = { 'tests.yml': WORKFLOW }, files = {}, description = descriptionFile().text } = {}) {
  const root = tmp();
  mkdirSync(path.join(root, 'apps/api'), { recursive: true });
  mkdirSync(path.join(root, 'tools/architecture'), { recursive: true });
  writeFileSync(path.join(root, 'tools/architecture/description.yml'), description);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    writeFileSync(path.join(root, name), text);
  }
  mkdirSync(path.join(root, '.github/workflows'), { recursive: true });
  writeFileSync(path.join(root, 'apps/api/wrangler.jsonc'), config);
  for (const [name, text] of Object.entries(workflows)) writeFileSync(path.join(root, '.github/workflows', name), text);
  return root;
}

/** The run's exit code and whether it left anything behind. */
async function draw(root) {
  const out = path.join(tmp(), 'index.html');
  const model = path.join(path.dirname(out), 'model.json');
  const code = await main(['--root', root, '--out', out, '--model', model]);
  return { code, out, model, page: existsSync(out), modelFile: existsSync(model) };
}

describe('A run that cannot read a file it needs fails and writes nothing', () => {
  it('writes the page and the model beside it when every file reads', async () => {
    const run = await draw(fixture());
    expect(run.code).toBe(0);
    expect(JSON.parse(readFileSync(run.model, 'utf8')).deployment.workflows.map((each) => each.file)).toEqual(['tests.yml']);
    expect(readFileSync(run.out, 'utf8')).toContain('<h1>Architecture</h1>');
  });

  it.each([
    { situation: 'the Worker config does not parse', make: () => fixture({ config: '{ "name": ' }) },
    { situation: 'a workflow does not parse', make: () => fixture({ workflows: { 'tests.yml': WORKFLOW, 'bad.yml': 'on: [\n' } }) },
    { situation: 'the Worker config is missing', make: () => { const root = fixture(); rmSync(path.join(root, 'apps/api/wrangler.jsonc')); return root; } },
    { situation: 'the description file is missing', make: () => { const root = fixture(); rmSync(path.join(root, 'tools/architecture/description.yml')); return root; } },
    { situation: 'the description file does not parse', make: () => fixture({ description: 'layers: [\n' }) },
    { situation: 'the description file leaves out what it must hold', make: () => fixture({ description: 'layers: []\n' }) },
    { situation: 'there are no workflows', make: () => fixture({ workflows: {} }) },
    { situation: 'a pin names an area that does not exist', make: () => fixture({ description: descriptionFile({ layers: [{ title: 'L', role: 'core', areas: [{ path: 'apps/api/src/http', description: 'd' }] }], pins: [{ above: 'apps/api/src/http', below: 'apps/api/src/typo' }] }).text }) },
  ])('exits non-zero with neither page nor model when $situation', async ({ make }) => {
    const run = await draw(make());
    expect(run.code).toBe(1);
    expect(run.page).toBe(false);
    expect(run.modelFile).toBe(false);
  });
});

describe('A flag that needs a path and is given none is refused', () => {
  it.each([['--out'], ['--root', '--json'], ['--model']])('exits 2 for %s', async (...argv) => {
    expect(await main(argv)).toBe(2);
  });
});

describe('This repository\'s own config and workflows draw without error', () => {
  it('reads the real Worker config and every real workflow, including the environments it declares', async () => {
    const run = await draw(checkout);
    expect(run.code).toBe(0);
    const { deployment } = JSON.parse(readFileSync(run.model, 'utf8'));
    expect(deployment.environments.map((each) => each.name)).toEqual(expect.arrayContaining(['production', 'staging', 'local']));
    expect(deployment.workflows.map((each) => each.file)).toEqual(expect.arrayContaining(['deploy-staging.yml', 'deploy-production.yml', 'nightly.yml']));
    const deploys = Object.fromEntries(deployment.workflows.map((each) => [each.file, each.deploys.map((d) => d.environment)]));
    expect(deploys['deploy-staging.yml']).toEqual(['staging']);
    expect(deploys['deploy-production.yml']).toEqual(['production']);
    expect(deployment.pages.workflow).toBe('publish.yml');
    expect(deployment.pages.reports).toEqual(expect.arrayContaining([{ artifact: 'architecture-report', path: '/architecture/' }, { artifact: 'test-explorer-report', path: '/' }]));
  });
});

describe('Modules', () => {
  const modelOf = async (root) => {
    const run = await draw(root);
    expect(run.code).toBe(0);
    return JSON.parse(readFileSync(run.model, 'utf8'));
  };

  it('draws this repository’s own areas as boxes, one per area on disk, none overlapping, with arrows between them', async () => {
    const run = await draw(checkout);
    expect(run.code).toBe(0);
    const { modules } = JSON.parse(readFileSync(run.model, 'utf8'));
    const page = readFileSync(run.out, 'utf8');
    const boxes = [...page.matchAll(/<rect class="[a-z]+" data-area="([^"]*)" x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/g)].map((each) => ({ area: each[1], x: +each[2], y: +each[3], w: +each[4], h: +each[5] }));
    expect(boxes.map((each) => each.area).sort()).toEqual(modules.layers.flatMap((layer) => layer.areas).map((each) => each.path).sort());
    for (const [at, a] of boxes.entries()) for (const b of boxes.slice(at + 1)) expect(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h, `${a.area} meets ${b.area}`).toBe(false);
    expect(page.match(/<line class="edge"/g)?.length).toBeGreaterThan(5);
  });

  it('finds the areas on disk by the description file’s own rules: folders, root files, packages, never tests or dependencies', async () => {
    const root = fixture({
      files: {
        'apps/web/src/main.tsx': 'export {}',
        'apps/api/src/http/app.ts': 'export {}',
        'apps/api/src/index.ts': 'export {}',
        'apps/api/src/only-tests/a.test.ts': 'export {}',
        'apps/api/src/node_modules/dep/x.ts': 'export {}',
        'packages/shared/package.json': '{}',
        'packages/shared/src/index.ts': '// gmail only in a comment\nexport {};',
        'packages/not-a-package/x.ts': 'export {}',
        'packages/connectors/teams/package.json': '{}',
        'packages/connectors/teams/src/index.ts': "import '@cockpit/shared';",
      },
    });
    const { modules } = await modelOf(root);
    const found = Object.fromEntries(modules.layers.flatMap((layer) => layer.areas).map((each) => [each.path, each]));
    expect(Object.keys(found).sort()).toEqual(['apps/api/src/*', 'apps/api/src/http', 'apps/web/src', 'packages/connectors/teams', 'packages/shared']);
    expect(found['packages/shared'].sources).toEqual([]);
    expect(found['packages/connectors/teams'].breaches).toEqual([{ file: 'src/index.ts', import: '@cockpit/shared' }]);
    expect(found['apps/api/src/*'].files).toBe(1);
  });

  it('describes every area on this repository’s disk today, and none that is no longer there', async () => {
    const { modules } = await modelOf(checkout);
    expect(modules.layers.flatMap((layer) => layer.areas).filter((each) => each.state !== 'described').map((each) => `${each.state}: ${each.path}`)).toEqual([]);
    expect(modules.counts.areas).toBeGreaterThan(10);
  });
});

describe('Dependencies', () => {
  const modelOf = async (root) => {
    const run = await draw(root);
    expect(run.code).toBe(0);
    return JSON.parse(readFileSync(run.model, 'utf8'));
  };

  it('reads a package’s name from its manifest, so another area importing it by name is counted against it', async () => {
    const root = fixture({
      files: {
        'apps/api/src/http/app.ts': "import { z } from '@cockpit/shared';\nimport { y } from '../auth/session.js';",
        'apps/api/src/auth/session.ts': "export const y = 1;\nexport * from '../http/app.js';",
        'apps/api/src/http/app.test.ts': "import '../mcp/x.js';",
        'packages/shared/package.json': '{ "name": "@cockpit/shared" }',
        'packages/shared/src/index.ts': 'export const z = 1;\n',
      },
      description: descriptionFile({ layers: [{ title: 'L', role: 'core', areas: ['apps/api/src/http', 'apps/api/src/auth', 'packages/shared'].map((path) => ({ path, description: 'd' })) }] }).text,
    });
    const { dependencies } = await modelOf(root);
    expect(dependencies.cells.map((each) => [each.from, each.to, each.files, each.kind])).toEqual([
      ['apps/api/src/http', 'apps/api/src/auth', 1, 'partner'],
      ['apps/api/src/http', 'packages/shared', 1, 'downward'],
      ['apps/api/src/auth', 'apps/api/src/http', 1, 'upward'],
    ]);
    expect(dependencies.areas.map((each) => [each.path, each.lines])).toEqual([['apps/api/src/http', 2], ['apps/api/src/auth', 2], ['packages/shared', 1]]);
  });

  it('draws this repository’s own areas: the web app leans on shared, the root files are muted, and every cell sits on two real areas', async () => {
    const { dependencies } = await modelOf(checkout);
    const paths = dependencies.areas.map((each) => each.path);
    expect(dependencies.areas.find((each) => each.muted)?.path).toBe('apps/api/src/*');
    expect(dependencies.cells.find((each) => each.from === 'apps/web/src' && each.to === 'packages/shared')?.files).toBeGreaterThan(10);
    for (const each of dependencies.cells) expect([paths.includes(each.from), paths.includes(each.to)]).toEqual([true, true]);
    for (const each of dependencies.areas.filter((one) => one.path !== 'packages/config')) expect(each.lines).toBeGreaterThan(0);
    expect(dependencies.cells.filter((each) => each.cycle && (each.from === 'apps/api/src/*' || each.to === 'apps/api/src/*'))).toEqual([]);
  });

  it('orders this repository’s own areas by the exact search, so a repository that outgrows it shows here before it shows on a night', async () => {
    const { dependencies } = await modelOf(checkout);
    expect(dependencies.order.method).toBe('exact');
    expect(dependencies.order.areas).toBeLessThanOrEqual(dependencies.order.limit);
    expect(dependencies.areas.at(-1).path).toBe('apps/api/src/*');
  });
});
