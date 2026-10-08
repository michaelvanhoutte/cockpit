import { describe, expect, it } from 'vitest';

import { diffModels } from '../../src/diff.js';
import { buildModel } from '../../src/model.js';
import { descriptionFile } from '../support/description.js';

const folder = (path, files, role = 'core') => ({ path, package: false, role, files: Object.entries(files).map(([file, text]) => ({ file: `${path}/${file}`, text })) });
const area = (path, description = `${path} does its job`) => ({ path, description });
const WORKFLOW = 'name: Tests\non:\n  pull_request:\njobs:\n  go:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n';

/** A model drawn by the real generator from a small repository. */
const draw = ({ areas = [], candidates = [], config = '{ "name": "w" }', workflows = [WORKFLOW], pins = [] } = {}) =>
  buildModel({
    wrangler: { file: 'apps/api/wrangler.jsonc', text: config },
    workflows: workflows.map((text, index) => ({ file: `w${index}.yml`, text })),
    description: descriptionFile({ layers: [{ title: 'API', note: '', role: 'core', areas }], pins }),
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
        situation: 'a new import that closes a cycle, called out as the upward half added',
        before: draw({ areas: both, candidates: [httpImportingJobs, jobs] }),
        after: draw({ areas: both, candidates: [httpImportingJobs, jobsImportingHttp] }),
        expected: [{ type: 'Dependency', change: 'added', where: ['apps/api/src/jobs', 'apps/api/src/http'], flag: 'new upward import' }],
      },
      {
        situation: 'a cycle broken by removing its upward half',
        before: draw({ areas: both, candidates: [httpImportingJobs, jobsImportingHttp] }),
        after: draw({ areas: both, candidates: [httpImportingJobs, jobs] }),
        expected: [{ type: 'Dependency', change: 'removed', where: ['apps/api/src/jobs', 'apps/api/src/http'] }],
      },
      {
        situation: 'a pin that flips which half points up, with the imports unchanged',
        before: draw({ areas: both, candidates: [httpImportingJobs, jobsImportingHttp] }),
        after: draw({ areas: both, candidates: [httpImportingJobs, jobsImportingHttp], pins: [{ above: 'apps/api/src/jobs', below: 'apps/api/src/http' }] }),
        expected: [
          { type: 'Dependency', change: 'added', where: ['apps/api/src/http', 'apps/api/src/jobs'], flag: 'new upward import' },
          { type: 'Dependency', change: 'removed', where: ['apps/api/src/jobs', 'apps/api/src/http'] },
        ],
      },
      {
        situation: 'imports gaining files without changing direction',
        before: draw({ areas: both, candidates: [httpImportingJobs, jobsImportingHttp] }),
        after: draw({ areas: both, candidates: [folder('apps/api/src/http', { 'app.ts': "import '../jobs/run';", 'more.ts': "import '../jobs/run';" }), jobsImportingHttp] }),
        expected: [],
      },
      {
        situation: 'a connector-named file arriving in a core area, called out',
        before: draw({ areas: both, candidates: [http, jobs] }),
        after: draw({ areas: both, candidates: [folder('apps/api/src/http', { 'app.ts': 'export const a = 1;', 'gmail.ts': '' }), jobs] }),
        expected: [{ type: 'Connector', change: 'added', where: ['apps/api/src/http/gmail.ts'], flag: 'connector file in the core' }],
      },
      {
        situation: 'a connector-named file moved into its connector’s package, leaving the core',
        before: draw({ areas: both, candidates: [folder('apps/api/src/http', { 'app.ts': 'export const a = 1;', 'gmail.ts': '' }), jobs] }),
        after: draw({ areas: both, candidates: [http, jobs] }),
        expected: [{ type: 'Connector', change: 'removed', where: ['apps/api/src/http/gmail.ts'] }],
      },
      {
        situation: 'a new mention of a source’s name',
        before: draw({ areas: both, candidates: [http, jobs] }),
        after: draw({ areas: both, candidates: [folder('apps/api/src/http', { 'app.ts': "export const a = 'gmail';" }), jobs] }),
        expected: [],
      },
      {
        situation: 'a model drawn before connectors were listed',
        before: { ...draw({ areas: both, candidates: [http, jobs] }), modules: { ...draw({ areas: both, candidates: [http, jobs] }).modules, connectors: undefined } },
        after: draw({ areas: both, candidates: [http, jobs] }),
        expected: [],
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

    it('lists no connector file when the source is newly declared or its package changes, since no file moved', () => {
      const gmailInCore = [folder('apps/api/src/http', { 'app.ts': 'export const a = 1;', 'gmail.ts': '' }), jobs];
      const drawn = (sources) =>
        buildModel({
          wrangler: { file: 'apps/api/wrangler.jsonc', text: '{ "name": "w" }' },
          workflows: [{ file: 'w0.yml', text: WORKFLOW }],
          description: descriptionFile({ layers: [{ title: 'API', note: '', role: 'core', areas: both }], sources }),
          candidates: gmailInCore,
          commit: null,
          date: null,
        });
      const gmail = { id: 'gmail', name: 'Gmail', words: ['gmail'] };
      expect(diffModels(drawn([]), drawn([gmail]))).toEqual([]);
      expect(diffModels(drawn([gmail]), drawn([{ ...gmail, package: 'packages/connectors/gmail' }]))).toEqual([]);
    });

    it('puts what the reader is meant to see first', () => {
      const before = draw({ areas: both, candidates: [http, jobs] });
      const after = draw({ areas: both, candidates: [folder('apps/api/src/http', { 'app.ts': 'export const a = 1;', 'gmail.ts': '' }), jobs], workflows: [WORKFLOW, WORKFLOW.replace('Tests', 'Deploy')] });
      expect(diffModels(before, after).map((each) => each.flag.label)).toEqual(['connector file in the core', 'added']);
    });

    it('does not list a count that moves with every merge', () => {
      const before = draw({ areas: both, candidates: [http, jobs] });
      const after = draw({ areas: both, candidates: [folder('apps/api/src/http', { 'app.ts': 'export const a = 1;', 'more.ts': 'export {};' }), jobs] });
      expect(diffModels(before, after)).toEqual([]);
    });
  });
});
