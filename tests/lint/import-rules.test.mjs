//
// The import rules ("Fail CI when the core imports source code, or an area
// imports against the agreed direction", issue 876): the pure functions over a
// small declaration written here, then the same checks over the real tree,
// which is the half that gates.
//
// Here rather than in `scripts/lib`, whose CI job is checkout-only and could not
// import the TypeScript parser (see lint-layer.test.mjs).
//

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import {
  baseAllowlistOf,
  checkTree,
  findBreaches,
  readBase,
  shrinkFailures,
  specifiersOf,
  tree,
} from '../../scripts/lib/import-rules.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '../..');

const rules = {
  sources: { gmail: {}, teams: { package: '@cockpit/connector-teams' }, 'claude-code': {} },
  core: ['apps/api', 'apps/web', 'packages/shared'],
  registry: 'apps/api/src/connectors/registry.ts',
  areas: {
    folder: 'apps/api/src',
    root: ['worker.ts', 'env.ts'],
    order: [['http'], ['jobs'], ['accounts'], ['db'], ['ai', 'embeddings'], ['domain']],
  },
  allowlist: [],
};

const api = (path) => `apps/api/src/${path}`;
const breachesOf = (importer, imported) => findBreaches([{ importer, imported, typeOnly: false }], rules);

describe('rule 1: an area imports only areas below it', () => {
  it('fails an accounts file importing a jobs file, naming both files and the rule', () => {
    const [breach] = breachesOf(api('accounts/store.ts'), api('jobs/debounce.ts'));
    assert.equal(breach.importer, api('accounts/store.ts'));
    assert.equal(breach.imported, api('jobs/debounce.ts'));
    assert.equal(breach.rule, 'accounts may not import jobs');
    assert.match(tree([breach], [])[0], /accounts\/store\.ts imports .*jobs\/debounce\.ts: accounts may not import jobs/);
  });

  it('passes a jobs file importing an accounts file', () => {
    assert.deepEqual(breachesOf(api('jobs/run.ts'), api('accounts/store.ts')), []);
  });

  it('fails a type-only import upward, since it couples just the same', () => {
    const source = "import type { Job } from '../jobs/debounce.js';";
    const [{ specifier, typeOnly }] = specifiersOf(api('accounts/store.ts'), source);
    assert.equal(typeOnly, true);
    assert.equal(specifier, '../jobs/debounce.js');
    assert.equal(breachesOf(api('accounts/store.ts'), api('jobs/debounce.ts')).length, 1);
  });

  it('passes a composition-root file importing any area, and any area importing a root file', () => {
    assert.deepEqual(breachesOf(api('worker.ts'), api('http/app.ts')), []);
    assert.deepEqual(breachesOf(api('db/client.ts'), api('env.ts')), []);
  });

  it('passes an import within one area, and between areas that share a tier', () => {
    assert.deepEqual(breachesOf(api('accounts/store.ts'), api('accounts/repo.ts')), []);
    assert.equal(breachesOf(api('ai/index.ts'), api('embeddings/index.ts')).length, 1);
  });

  it('fails an area the declaration does not name, naming it', () => {
    const [breach] = breachesOf(api('newarea/thing.ts'), api('domain/item.ts'));
    assert.equal(breach.rule, 'newarea is not a declared area');
  });
});

describe('rule 2: the core does not import source code', () => {
  it('passes the registry importing a connector package', () => {
    assert.deepEqual(breachesOf(rules.registry, '@cockpit/connector-teams'), []);
  });

  it('fails any other core file importing a connector package, in the API or the web app', () => {
    assert.equal(breachesOf(api('http/app.ts'), '@cockpit/connector-teams').length, 1);
    assert.equal(breachesOf('apps/web/src/main.tsx', '@cockpit/connector-teams').length, 1);
  });

  it('fails an unnamed core file importing a file named for a source', () => {
    const [breach] = breachesOf(api('accounts/store.ts'), api('accounts/gmail.ts'));
    assert.equal(breach.rule, 'the core may not import gmail code from a file not named for gmail');
    assert.equal(breachesOf('apps/web/src/components/ManageConnections.tsx', 'apps/web/src/components/ConnectClaudeCode.tsx').length, 1);
  });

  it('passes a file named for a source importing another file named for the same source', () => {
    assert.deepEqual(breachesOf(api('connectors/gmail-check.ts'), api('connectors/gmail.ts')), []);
    assert.deepEqual(breachesOf(api('http/gmail-routes.ts'), api('http/gmail.ts')), []);
  });
});

describe('rule 3: the allowlist can only shrink', () => {
  const breach = { importer: api('accounts/store.ts'), imported: api('jobs/debounce.ts'), rule: 'accounts may not import jobs' };
  const entry = { from: breach.importer, to: breach.imported };

  it('passes a breach that is on the allowlist', () => {
    assert.deepEqual(tree([breach], [entry]), []);
  });

  it('fails an allowlist entry whose import is gone, naming the entry to remove', () => {
    const failures = tree([], [entry]);
    assert.equal(failures.length, 1);
    assert.match(failures[0], /remove it: .*accounts\/store\.ts -> .*jobs\/debounce\.ts/);
  });

  it("fails an entry absent from the merge base's allowlist, naming the entry", () => {
    const failures = shrinkFailures([entry], []);
    assert.equal(failures.length, 1);
    assert.match(failures[0], /accounts\/store\.ts -> .*jobs\/debounce\.ts/);
    assert.deepEqual(shrinkFailures([entry], [entry]), []);
  });

  it("fails loudly when the merge base's copy cannot be read, and skips only where there is no base to read", () => {
    const failing = (args) => {
      throw new Error(`git ${args.join(' ')} failed`);
    };
    const pullRequest = readBase({ event: 'pull_request', ci: true, git: failing });
    assert.match(pullRequest.error, /no merge base/);

    const git = (args) => {
      if (args[0] === 'rev-list') return 'head base other';
      if (args[0] === 'cat-file') throw new Error('bad object');
      return '';
    };
    assert.match(readBase({ event: 'pull_request', ci: true, git }).error, /bad object/);

    assert.ok(readBase({ event: 'push', ci: true, git: failing }).skipped);
    assert.deepEqual(baseAllowlistOf(JSON.stringify({ allowlist: [entry] })), [entry]);
  });
});

describe('specifiersOf', () => {
  it('reads static, re-exported and dynamic imports, and leaves comments and strings alone', () => {
    const source = [
      "import a from './a.js';",
      "export * from './b.js';",
      "export type { T } from './c.js';",
      "const d = await import('./d.js');",
      "// import x from './comment.js';",
      "const s = \"import y from './string.js'\";",
    ].join('\n');
    assert.deepEqual(
      specifiersOf('x.ts', source).map((found) => found.specifier),
      ['./a.js', './b.js', './c.js', './d.js'],
    );
  });
});

describe("today's tree", () => {
  it('passes, with the allowlist holding exactly the breaches the tree has', () => {
    const git = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
    const base = readBase({ event: process.env.GITHUB_EVENT_NAME, ci: process.env.GITHUB_ACTIONS === 'true', git });
    if (base.skipped) console.log(`# shrink-only comparison skipped: ${base.skipped}`);
    assert.deepEqual(checkTree(repo, base), []);
  });
});
