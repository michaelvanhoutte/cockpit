import { describe, expect, it } from 'vitest';

import { diffModels } from '../../src/diff.js';
import { buildModel } from '../../src/model.js';
import { descriptionFile } from '../support/description.js';

const folder = (path, files, role = 'core') => ({ path, package: false, role, files: Object.entries(files).map(([file, text]) => ({ file: `${path}/${file}`, text })) });
const area = (path, description = `${path} does its job`) => ({ path, description });
const WORKFLOW = 'name: Tests\non:\n  pull_request:\njobs:\n  go:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n';

/** A model drawn by the real generator from a small repository. */
const draw = ({ areas = [], candidates = [], config = '{ "name": "w" }', workflows = [WORKFLOW] } = {}) =>
  buildModel({
    wrangler: { file: 'apps/api/wrangler.jsonc', text: config },
    workflows: workflows.map((text, index) => ({ file: `w${index}.yml`, text })),
    description: descriptionFile({ layers: [{ title: 'API', note: '', role: 'core', areas }] }),
    candidates,
    commit: null,
    date: null,
  });

const http = folder('apps/api/src/http', { 'app.ts': 'export const a = 1;' });
const jobs = folder('apps/api/src/jobs', { 'run.ts': 'export const b = 1;' });
const both = [area('apps/api/src/http'), area('apps/api/src/jobs')];
const httpImportingJobs = folder('apps/api/src/http', { 'app.ts': "import '../jobs/run';" });
const jobsImportingHttp = folder('apps/api/src/jobs', { 'run.ts': "import '../http/app';" });

describe('What changed', () => {
  describe('lists everything added, removed or changed between two models', () => {
    it.each([
      {
        situation: 'a new area',
        before: draw({ areas: [area('apps/api/src/http')], candidates: [http] }),
        after: draw({ areas: both, candidates: [http, jobs] }),
        expected: [{ type: 'Area', change: 'added', where: ['apps/api/src/jobs'] }],
      },
      {
        situation: 'a removed binding',
        before: draw({ config: '{ "name": "w", "kv_namespaces": [{ "binding": "CACHE", "id": "abc" }] }' }),
        after: draw(),
        expected: [{ type: 'Resource', change: 'removed', where: ['production'] }],
      },
      {
        situation: 'an area’s description reworded',
        before: draw({ areas: [area('apps/api/src/http', 'The routes')], candidates: [http] }),
        after: draw({ areas: [area('apps/api/src/http', 'Every route and the stream')], candidates: [http] }),
        expected: [{ type: 'Area', change: 'changed', where: ['apps/api/src/http'] }],
      },
      {
        situation: 'a new dependency between two areas',
        before: draw({ areas: both, candidates: [http, jobs] }),
        after: draw({ areas: both, candidates: [httpImportingJobs, jobs] }),
        expected: [{ type: 'Dependency', change: 'added', where: ['apps/api/src/http', 'apps/api/src/jobs'] }],
      },
      {
        situation: 'a new workflow',
        before: draw({ workflows: [WORKFLOW] }),
        after: draw({ workflows: [WORKFLOW, WORKFLOW.replace('Tests', 'Deploy')] }),
        expected: [{ type: 'Workflow', change: 'added', where: ['.github/workflows/w1.yml'] }],
      },
      {
        situation: 'a dependency that became mutual, called out once for the pair',
        before: draw({ areas: both, candidates: [httpImportingJobs, jobs] }),
        after: draw({ areas: both, candidates: [httpImportingJobs, jobsImportingHttp] }),
        expected: [{ type: 'Dependency', change: 'changed', where: ['apps/api/src/http', 'apps/api/src/jobs'], flag: 'new mutual pair' }],
      },
      {
        situation: 'a new source mark in the core',
        before: draw({ areas: both, candidates: [http, jobs] }),
        after: draw({ areas: both, candidates: [folder('apps/api/src/http', { 'app.ts': "export const a = 'gmail';" }), jobs] }),
        expected: [{ type: 'Mark', change: 'added', where: ['apps/api/src/http/app.ts'], flag: 'new source mark' }],
      },
      {
        situation: 'two identical models',
        before: draw({ areas: both, candidates: [http, jobs] }),
        after: draw({ areas: both, candidates: [http, jobs] }),
        expected: [],
      },
    ])('$situation', ({ before, after, expected }) => {
      const rows = diffModels(before, after).map((each) => ({ type: each.type, change: each.change, where: each.where, ...(each.flag.tone === 'call' ? { flag: each.flag.label } : {}) }));
      expect(rows).toEqual(expected);
    });

    it('puts what the reader is meant to see first', () => {
      const before = draw({ areas: both, candidates: [http, jobs] });
      const after = draw({ areas: both, candidates: [folder('apps/api/src/http', { 'app.ts': "export const a = 'gmail';" }), jobs], workflows: [WORKFLOW, WORKFLOW.replace('Tests', 'Deploy')] });
      expect(diffModels(before, after).map((each) => each.flag.label)).toEqual(['new source mark', 'added']);
    });

    it('does not list a count that moves with every merge', () => {
      const before = draw({ areas: both, candidates: [http, jobs] });
      const after = draw({ areas: both, candidates: [folder('apps/api/src/http', { 'app.ts': 'export const a = 1;', 'more.ts': 'export {};' }), jobs] });
      expect(diffModels(before, after)).toEqual([]);
    });
  });
});
