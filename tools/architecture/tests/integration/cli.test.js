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
function fixture({ config = '{ // comment\n "name": "w", }\n', workflows = { 'tests.yml': WORKFLOW } } = {}) {
  const root = tmp();
  mkdirSync(path.join(root, 'apps/api'), { recursive: true });
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
    expect(readFileSync(run.out, 'utf8')).toContain('<h1>Deployment</h1>');
  });

  it.each([
    { situation: 'the Worker config does not parse', make: () => fixture({ config: '{ "name": ' }) },
    { situation: 'a workflow does not parse', make: () => fixture({ workflows: { 'tests.yml': WORKFLOW, 'bad.yml': 'on: [\n' } }) },
    { situation: 'the Worker config is missing', make: () => { const root = fixture(); rmSync(path.join(root, 'apps/api/wrangler.jsonc')); return root; } },
    { situation: 'there are no workflows', make: () => fixture({ workflows: {} }) },
  ])('exits non-zero with neither page nor model when $situation', async ({ make }) => {
    const run = await draw(make());
    expect(run.code).toBe(1);
    expect(run.page).toBe(false);
    expect(run.modelFile).toBe(false);
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
  });
});
