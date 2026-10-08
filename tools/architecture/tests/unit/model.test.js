import { describe, expect, it } from 'vitest';

import { buildModel, describeCron, ReadError } from '../../src/model.js';

/** A Worker config in the shape the real one has: JSONC, with comments and a trailing comma. */
const config = (overrides = {}) =>
  JSON.stringify(
    {
      name: 'cockpit',
      assets: { directory: '../web/dist', binding: 'ASSETS' },
      ai: { binding: 'AI', remote: true },
      durable_objects: { bindings: [{ name: 'ACCOUNT', class_name: 'AccountStore' }] },
      d1_databases: [{ binding: 'DB', database_name: 'cockpit', database_id: 'id-1' }],
      r2_buckets: [{ binding: 'ATTACHMENTS', bucket_name: 'cockpit-attachments' }],
      kv_namespaces: [{ binding: 'OAUTH_KV', id: 'kv-prod' }],
      queues: { producers: [{ queue: 'cockpit-enrichment', binding: 'ENRICHMENT' }], consumers: [{ queue: 'cockpit-enrichment' }] },
      triggers: { crons: ['0 3 * * *'] },
      env: {
        staging: {
          name: 'cockpit-staging',
          ai: { binding: 'AI' },
          d1_databases: [{ binding: 'DB', database_name: 'cockpit-staging', database_id: 'id-2' }],
          r2_buckets: [{ binding: 'ATTACHMENTS', bucket_name: 'cockpit-attachments-staging' }],
          queues: { producers: [{ queue: 'cockpit-enrichment-staging', binding: 'ENRICHMENT' }] },
        },
        local: {
          name: 'cockpit-local',
          d1_databases: [{ binding: 'DB', database_name: 'cockpit', database_id: 'id-1' }],
        },
      },
      ...overrides,
    },
    null,
    2,
  ).replace('{\n', '{\n  // a comment, as the real file has many\n').replace(/\n}$/, ',\n}');

const model = (wrangler = config(), workflows = []) =>
  buildModel({ wrangler: { file: 'apps/api/wrangler.jsonc', text: wrangler }, workflows, commit: 'abc1234def', date: '2026-10-08T13:03:04+02:00' });

const environment = (built, name) => built.deployment.environments.find((each) => each.name === name);
const named = (resources, kind) => resources.filter((each) => each.kind === kind).map((each) => each.name);

describe('Deployment', () => {
  describe('every environment the Worker config declares appears with each resource it binds, under that environment\'s own name', () => {
    it('names production\'s database, Durable Object, bucket, KV namespace, queue, cron and AI binding as production names them', () => {
      const { resources } = environment(model(), 'production');
      expect(named(resources, 'D1 database')).toEqual(['cockpit']);
      expect(named(resources, 'Durable Object')).toEqual(['AccountStore']);
      expect(named(resources, 'R2 bucket')).toEqual(['cockpit-attachments']);
      expect(named(resources, 'KV namespace')).toEqual(['kv-prod']);
      expect(named(resources, 'Queue, producer')).toEqual(['cockpit-enrichment']);
      expect(named(resources, 'Cron trigger')).toEqual(['0 3 * * *']);
      expect(resources.find((each) => each.kind === 'Workers AI').binding).toBe('AI');
    });

    it('gives staging its own database, bucket and queue, never production\'s', () => {
      const { resources } = environment(model(), 'staging');
      expect(named(resources, 'D1 database')).toEqual(['cockpit-staging']);
      expect(named(resources, 'R2 bucket')).toEqual(['cockpit-attachments-staging']);
      expect(named(resources, 'Queue, producer')).toEqual(['cockpit-enrichment-staging']);
      expect(resources.map((each) => each.name)).not.toContain('cockpit-attachments');
    });

    it('shows a setting declared once at the top under every environment that inherits it, marked inherited', () => {
      const built = model();
      for (const name of ['production', 'staging', 'local']) {
        const cron = environment(built, name).resources.find((each) => each.kind === 'Cron trigger');
        expect(cron.name).toBe('0 3 * * *');
        expect(cron.inherited).toBe(name !== 'production');
      }
    });

    it('lets an environment\'s own triggers replace the inherited ones', () => {
      const own = config({ env: { staging: { triggers: { crons: ['5 5 * * *'] } } } });
      const crons = environment(model(own), 'staging').resources.filter((each) => each.kind === 'Cron trigger');
      expect(crons.map((each) => [each.name, each.inherited])).toEqual([['5 5 * * *', false]]);
    });

    it('leaves out a setting that is not inheritable and an environment does not declare', () => {
      const { resources } = environment(model(), 'local');
      expect(named(resources, 'KV namespace')).toEqual([]);
      expect(named(resources, 'R2 bucket')).toEqual([]);
      expect(named(resources, 'Queue, producer')).toEqual([]);
    });

    it('shows the local environment as local development, without the AI binding', () => {
      const local = environment(model(), 'local');
      expect(local.kind).toBe('local development');
      expect(local.resources.some((each) => each.kind === 'Workers AI')).toBe(false);
    });

    it('shows a binding kind it does not know under its raw kind, not dropped', () => {
      const unknown = config({ vectorize: [{ binding: 'INDEX', index_name: 'notes', name: 'notes-index' }], browser: { binding: 'BROWSER' } });
      const { resources } = environment(model(unknown), 'production');
      expect(resources.filter((each) => each.kind === 'vectorize').map((each) => [each.binding, each.name])).toEqual([['INDEX', 'notes-index']]);
      expect(resources.find((each) => each.kind === 'browser').binding).toBe('BROWSER');
    });

    it('draws each environment\'s Worker under the name Wrangler gives it', () => {
      const built = model(config({ env: { staging: { name: 'cockpit-staging' }, qa: {} } }));
      expect(environment(built, 'staging').worker).toBe('cockpit-staging');
      expect(environment(built, 'qa').worker).toBe('cockpit-qa');
      expect(environment(built, 'qa').kind).toBe('environment');
    });
  });

  describe('every workflow appears with what starts it, and a deploying workflow names the environment it deploys', () => {
    const workflow = (on, step = 'echo hi') => `name: Some workflow\non:\n${on}\njobs:\n  go:\n    runs-on: ubuntu-latest\n    steps:\n      - run: ${step}\n`;
    const wrangler = (command) =>
      `name: W\non:\n  push:\n    branches: [main]\njobs:\n  go:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: cloudflare/wrangler-action@v3\n        with:\n          command: ${command}\n`;
    const drawn = (file, text, ...others) => model(config(), [{ file, text }, ...others]).deployment.workflows.find((each) => each.file === file);

    it('says "every merge" for a push to main and points at staging', () => {
      const built = drawn('deploy-staging.yml', wrangler('deploy --env staging'));
      expect(built.starts.map((each) => each.text)).toEqual(['every merge']);
      expect(built.deploys).toEqual([{ environment: 'staging', declared: true }]);
    });

    it('says "by hand" for a manual start with an input and points at production, whichever way the empty environment is written', () => {
      const text = `name: Promote\non:\n  workflow_dispatch:\n    inputs:\n      sha:\n        required: false\njobs:\n  go:\n    runs-on: ubuntu-latest\n    steps:\n      - run: pnpm exec wrangler deploy --env=""\n`;
      const built = drawn('deploy-production.yml', text);
      expect(built.starts).toEqual([{ event: 'workflow_dispatch', text: 'by hand', inputs: ['sha'] }]);
      expect(built.deploys).toEqual([{ environment: 'production', declared: true }]);
      expect(drawn('plain.yml', wrangler('deploy')).deploys[0].environment).toBe('production');
    });

    it('gives a scheduled workflow its time', () => {
      expect(drawn('nightly.yml', workflow("  schedule:\n    - cron: '17 4 * * *'")).starts.map((each) => each.text)).toEqual(['every night at 04:17 UTC']);
      expect(describeCron('0 3 * * 1')).toBe('every Monday at 03:00 UTC');
      expect(describeCron('*/5 * * * *')).toBe('on schedule */5 * * * *');
    });

    it('names a workflow only others call as called by them', () => {
      const caller = { file: 'ci.yml', text: workflow('  push:\n    branches: [main]').replace('steps:\n      - run: echo hi', 'uses: ./.github/workflows/publish.yml') };
      const built = drawn('publish.yml', workflow('  workflow_call:'), caller);
      expect(built.starts.map((each) => each.text)).toEqual(['called by ci.yml']);
      expect(built.calledBy).toEqual(['ci.yml']);
    });

    it('names no environment for a workflow that deploys nothing', () => {
      expect(drawn('tests.yml', workflow('  pull_request:')).deploys).toEqual([]);
    });

    it('draws an event it has no wording for as its own name, and flags a deploy to an environment the config lacks', () => {
      expect(drawn('c.yml', workflow('  issue_comment:')).starts.map((each) => each.text)).toEqual(['issue comment']);
      expect(drawn('x.yml', wrangler('deploy --env qa')).deploys).toEqual([{ environment: 'qa', declared: false }]);
    });

    it('lists the workflows that deploy an environment on that environment', () => {
      const built = model(config(), [{ file: 'deploy-staging.yml', text: wrangler('deploy --env staging') }]);
      expect(environment(built, 'staging').deployedBy).toEqual(['deploy-staging.yml']);
      expect(environment(built, 'production').deployedBy).toEqual([]);
    });
  });

  describe('a file it cannot read is refused, naming the file', () => {
    it.each([
      { situation: 'a Worker config that is not JSONC', build: () => model('{ "name": ') },
      { situation: 'a Worker config that is not an object', build: () => model('[1]') },
      { situation: 'a workflow that is not YAML', build: () => model(config(), [{ file: 'bad.yml', text: 'on: [\n' }]) },
      { situation: 'a workflow with nothing to start it', build: () => model(config(), [{ file: 'bad.yml', text: 'jobs: {}\n' }]) },
    ])('refuses $situation', ({ build }) => {
      expect(build).toThrow(ReadError);
    });
  });
});
