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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import {
    checkTree,
  failuresAgainst,
  findBreaches,
  relaxations,
  sourcePackages,
  sourcesNamedBy,
  readBase,
  shrinkFailures,
  specifiersOf,
} from '../../scripts/lib/import-rules.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '../..');

const rules = {
  sources: { gmail: {}, teams: { package: '@cockpit/connector-teams' }, 'claude-code': {} },
  core: ['apps/api', 'apps/web', 'packages/shared'],
  registry: 'apps/api/src/connectors/registry.ts',
  areas: {
    folder: 'apps/api/src',
    root: ['worker.ts', 'env.ts', 'index.ts'],
    sharedRoot: ['env.ts'],
    order: [['http'], ['jobs'], ['accounts'], ['db'], ['ai', 'embeddings'], ['domain']],
  },
  allowlist: [],
};

const api = (path) => `apps/api/src/${path}`;
const breachesOf = (importer, imported) => findBreaches([{ importer, imported, typeOnly: false }], rules);

describe('rule 1: an area imports only areas below it', () => {
  it('fails an accounts file importing a jobs file, naming both files and the rule', () => {
    const [breach] = breachesOf(api('accounts/store.ts'), api('jobs/debounce.ts'));
    assert.equal(breach.from, api('accounts/store.ts'));
    assert.equal(breach.to, api('jobs/debounce.ts'));
    assert.equal(breach.rule, 'accounts may not import jobs');
    assert.match(failuresAgainst([breach], [])[0], /accounts\/store\.ts imports .*jobs\/debounce\.ts: accounts may not import jobs/);
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
  const breach = { from: api('accounts/store.ts'), to: api('jobs/debounce.ts'), rule: 'accounts may not import jobs' };
  const entry = { from: breach.from, to: breach.to };

  it('passes a breach that is on the allowlist', () => {
    assert.deepEqual(failuresAgainst([breach], [entry]), []);
  });

  it('fails an allowlist entry whose import is gone, naming the entry to remove', () => {
    const failures = failuresAgainst([], [entry]);
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

describe('root files as import targets', () => {
  it('lets any area import a shared root file, and flags an area importing the other root files', () => {
    assert.deepEqual(breachesOf(api('db/client.ts'), api('env.ts')), []);
    for (const file of ['index.ts', 'worker.ts']) {
      const [breach] = breachesOf(api('db/client.ts'), api(file));
      assert.equal(breach.rule, `db may not import the composition root file ${file}`);
    }
  });
});

describe('naming a source', () => {
  it('matches a source inside a folder or a file name, however it is cased or hyphenated', () => {
    assert.deepEqual(sourcesNamedBy('apps/web/src/components/ConnectClaudeCode.tsx', rules), ['claude-code']);
    assert.deepEqual(sourcesNamedBy('apps/api/src/gmail/check.ts', rules), ['gmail']);
  });

  it('does not match a name spelled across two segments, or an extension', () => {
    assert.deepEqual(sourcesNamedBy('apps/api/src/tea/ms.ts', rules), []);
    assert.deepEqual(sourcesNamedBy('apps/api/src/gma/il.ts', rules), []);
    assert.deepEqual(sourcesNamedBy('apps/api/src/notes.gmail', rules), []);
  });
});

describe('source packages', () => {
  it('counts every package under packages/connectors, declared or not', () => {
    const dir = mkdtempSync(join(tmpdir(), 'import-rules-'));
    try {
      mkdirSync(join(dir, 'packages/connectors/slack'), { recursive: true });
      writeFileSync(join(dir, 'packages/connectors/slack/package.json'), JSON.stringify({ name: '@cockpit/connector-slack' }));
      assert.deepEqual(sourcePackages(dir, rules).sort(), ['@cockpit/connector-slack', '@cockpit/connector-teams']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('relaxing the rules themselves', () => {
  const change = (edit) => {
    const copy = structuredClone(rules);
    edit(copy);
    return copy;
  };

  it('passes unchanged rules, and additions that keep every relation', () => {
    assert.deepEqual(relaxations(rules, rules), []);
    const added = change((r) => {
      r.sources.slack = {};
      r.core.push('packages/other');
      r.areas.root = ['worker.ts', 'env.ts'];
      r.areas.order.splice(2, 0, ['audit']);
    });
    assert.deepEqual(relaxations(added, rules), []);
  });

  it('fails a removed source, a removed core folder, a changed registry and a dropped package, naming each', () => {
    const failures = relaxations(
      change((r) => {
        delete r.sources.gmail;
        r.sources.teams = {};
        r.core = ['apps/api'];
        r.registry = 'apps/api/src/other.ts';
      }),
      rules,
    );
    assert.deepEqual(failures.length, 5);
    assert.match(failures.join('\n'), /source gmail was removed/);
    assert.match(failures.join('\n'), /source teams no longer names its package/);
    assert.match(failures.join('\n'), /core folder apps\/web was removed/);
    assert.match(failures.join('\n'), /registry changed/);
  });

  it('fails widening the root lists', () => {
    const failures = relaxations(change((r) => { r.areas.root.push('app.ts'); r.areas.sharedRoot.push('index.ts'); }), rules);
    assert.match(failures.join('\n'), /app\.ts was added to the composition root/);
    assert.match(failures.join('\n'), /index\.ts was added to the root files any area may import/);
  });

  it('fails reordering, removing or merging areas', () => {
    assert.match(relaxations(change((r) => { r.areas.order = [['jobs'], ['http'], ['accounts'], ['db'], ['ai', 'embeddings'], ['domain']]; }), rules).join('\n'), /http no longer stays above jobs/);
    assert.match(relaxations(change((r) => { r.areas.order = r.areas.order.filter((tier) => tier[0] !== 'jobs'); }), rules).join('\n'), /http no longer stays above jobs/);
    assert.match(relaxations(change((r) => { r.areas.order[4] = ['ai']; r.areas.order.splice(5, 0, ['embeddings']); }), rules).join('\n'), /ai and embeddings no longer share a tier/);
  });
});
