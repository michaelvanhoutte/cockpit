//
// The import rules, read from docs/architecture.yml ("Fail CI when the core imports source code, or an area
// imports against the agreed direction", issue 876): the pure functions over a
// small declaration written here, then the same checks over the real tree,
// which is the half that gates.
//
// Here rather than in `scripts/lib`, whose CI job is checkout-only and could not
// import the TypeScript parser (see lint-layer.test.mjs).
//

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { paidCallFiles } from '../../scripts/lib/provider-calls.mjs';
import {
  checkTree,
  failuresAgainst,
  findBreaches,
  namedSourceFailure,
  namedSourceIds,
  namedSourcesIn,
  parseRulesFile,
  readNamedSources,
  readRules,
  relaxations,
  rulesFromFile,
  rulesFromOldJson,
  shapeFailures,
  sourcePackages,
  sourcesNamedBy,
  readBase,
  shrinkFailures,
  specifiersOf,
} from '../../scripts/lib/import-rules.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '../..');

const rules = {
  sources: { gmail: {}, teams: { package: '@cockpit/connector-teams' }, 'claude-code': { engine: true } },
  core: ['apps/api', 'apps/web', 'packages/shared'],
  registry: 'apps/api/src/connectors/registry.ts',
  engines: ['apps/api/src/engines/list.ts', 'apps/web/src/components/engines.ts'],
  areas: {
    folder: 'apps/api/src',
    root: ['worker.ts', 'env.ts', 'index.ts'],
    sharedRoot: ['env.ts'],
    order: [['http'], ['jobs'], ['engines'], ['connectors'], ['accounts'], ['db'], ['ai', 'embeddings'], ['domain']],
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

describe('the engine list: the core reaches an engine only through it', () => {
  const web = (path) => `apps/web/src/components/${path}`;

  it('fails a generic file importing the engine, naming both files', () => {
    const [breach] = breachesOf(api('http/app.ts'), api('engines/claude-code.ts'));
    assert.equal(breach.from, api('http/app.ts'));
    assert.equal(breach.to, api('engines/claude-code.ts'));
    assert.match(failuresAgainst([breach], [])[0], /http\/app\.ts imports .*engines\/claude-code\.ts: .*claude-code/);
    assert.equal(breachesOf(web('ManageConnections.tsx'), web('ConnectClaudeCode.tsx')).length, 1);
  });

  it('passes the engine list importing the engine, in the API and in the web app', () => {
    assert.deepEqual(breachesOf(api('engines/list.ts'), api('engines/claude-code.ts')), []);
    assert.deepEqual(breachesOf(web('engines.ts'), web('ConnectClaudeCode.tsx')), []);
  });

  it('fails the engine list importing a source that is not an engine', () => {
    assert.equal(breachesOf(api('engines/list.ts'), api('connectors/gmail.ts')).length, 1);
    assert.equal(breachesOf(web('engines.ts'), web('ConnectGmail.tsx')).length, 1);
  });

  it('flags a source made an engine as a relaxation', () => {
    const made = structuredClone(rules);
    made.sources.gmail.engine = true;
    assert.match(relaxations(made, rules).join('\n'), /source gmail became an engine/);
  });

  it('passes a generic file importing the engine list, which is not named for an engine', () => {
    assert.deepEqual(breachesOf(api('http/app.ts'), api('engines/list.ts')), []);
    assert.deepEqual(breachesOf(web('ManageConnections.tsx'), web('engines.ts')), []);
  });

  it('keeps the engine area below the core areas that reach it and above the ones it reaches', () => {
    assert.deepEqual(breachesOf(api('http/app.ts'), api('engines/list.ts')), []);
    assert.equal(breachesOf(api('accounts/store.ts'), api('engines/list.ts')).length, 1);
    assert.deepEqual(breachesOf(api('engines/claude-code-hooks.ts'), api('connectors/credential-crypto.ts')), []);
  });
});

describe('rule 3: the allowlist can only shrink', () => {
  const [breach] = breachesOf(api('accounts/store.ts'), api('jobs/debounce.ts'));
  const entry = { from: breach.from, to: 'jobs' };

  it('passes a breach that is on the allowlist', () => {
    assert.deepEqual(failuresAgainst([breach], [entry]), []);
  });

  it('fails an allowlist entry whose import is gone, naming the entry to remove', () => {
    const failures = failuresAgainst([], [entry]);
    assert.equal(failures.length, 1);
    assert.match(failures[0], /remove it: .*accounts\/store\.ts -> jobs/);
  });

  it("fails an entry absent from the merge base's allowlist, naming the entry", () => {
    const failures = shrinkFailures([entry], []);
    assert.equal(failures.length, 1);
    assert.match(failures[0], /accounts\/store\.ts -> jobs/);
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
  it('passes with nothing excused: every API area imports only the areas below it', () => {
    assert.deepEqual(readRules(repo).allowlist, []);
    const git = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
    const base = readBase({ event: process.env.GITHUB_EVENT_NAME, ci: process.env.GITHUB_ACTIONS === 'true', git });
    if (base.skipped) console.log(`# shrink-only comparison skipped: ${base.skipped}`);
    assert.deepEqual(checkTree(repo, base), []);
  });
});

describe('rule 4: the core does not write a source id as a string', () => {
  const ids = namedSourceIds(rules);
  const exempt = [
    'apps/api/src/accounts/changes.ts',
    'apps/api/src/accounts/guest-seed-data.ts',
    'packages/shared/src/domain/demo-address.ts',
  ];
  const namedRules = { ...rules, names: { exempt } };
  const tree = (files) => {
    const dir = mkdtempSync(join(tmpdir(), 'names-rule-'));
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    return dir;
  };
  const failuresOver = (files, declaration = namedRules) => {
    const dir = tree(files);
    try {
      return readNamedSources(dir, declaration).map(namedSourceFailure);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("fails a string in an API file's code, naming file, line and id", () => {
    const failures = failuresOver({ [api('http/app.ts')]: "const a = 1;\nconst source = 'gmail';\n" });
    assert.equal(failures.length, 1);
    assert.match(failures[0], /apps\/api\/src\/http\/app\.ts:2 .*"gmail"/);
  });

  it('fails a template literal holding the id, with or without a substitution', () => {
    assert.deepEqual(namedSourcesIn('x.ts', 'const a = `teams`;', ids), [{ line: 1, id: 'teams' }]);
    assert.deepEqual(namedSourcesIn('x.ts', 'const a = `${prefix}teams`;', ids), [{ line: 1, id: 'teams' }]);
    assert.deepEqual(namedSourcesIn('x.ts', 'const a = `${ { b: 1 }.b }\n${c}`;\nconst d = "gmail";', ids), [{ line: 3, id: 'gmail' }]);
  });

  it('passes the id in a comment, in an identifier, and in longer text', () => {
    const source = [
      "// 'gmail' is named here",
      "/* const s = 'teams'; */",
      'const gmailLink = teams.gmail;',
      "const key = 'gmail-check-account';",
      "const copy = 'Connect your Gmail';",
    ].join('\n');
    assert.deepEqual(namedSourcesIn('x.ts', source, ids), []);
  });

  it('passes the migrations, the guest demo seed and the engine list, and a connector package, which is not core', () => {
    const named = "export const id = 'gmail';\n";
    assert.deepEqual(
      failuresOver({
        [api('accounts/changes.ts')]: named,
        [api('accounts/guest-seed-data.ts')]: named,
        'packages/shared/src/domain/demo-address.ts': 'export const pages = ["gmail", "teams"];\n',
        [api('engines/list.ts')]: "export const id = 'teams';\n",
        'packages/connectors/gmail/src/manifest.ts': named,
      }),
      [],
    );
  });

  it('still finds a literal after a regular expression holding a quote or a backtick on the same line', () => {
    assert.deepEqual(namedSourcesIn('x.ts', "const a = /`/.test(s) && b === 'gmail';", ids), [{ line: 1, id: 'gmail' }]);
    assert.deepEqual(namedSourcesIn('x.ts', "const a = /it's/.test(s) ? `teams` : 1;", ids), [{ line: 1, id: 'teams' }]);
    assert.deepEqual(namedSourcesIn('x.tsx', "const a = <p>don't {'gmail'}</p>;", ids), [{ line: 1, id: 'gmail' }]);
  });

  it('leaves an engine to the engine list: its id is not a name the core may not write', () => {
    const declared = { sources: { slack: {}, 'some-engine': { engine: true } } };
    assert.deepEqual(namedSourceIds(declared), ['slack']);
  });

  it('flags a file added to the files that may name a source as a relaxation', () => {
    const widened = structuredClone(namedRules);
    widened.names.exempt.push(api('http/app.ts'));
    assert.match(relaxations(widened, namedRules).join('\n'), /http\/app\.ts was added to the files that may name a source/);
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
    assert.match(relaxations(change((r) => { r.areas.order[6] = ['ai']; r.areas.order.splice(7, 0, ['embeddings']); }), rules).join('\n'), /ai and embeddings no longer share a tier/);
  });
});

// The rules file as a parsed object, small enough to change one thing at a time.
const fileDoc = () => ({
  cockpit: {
    layers: {
      api: { parts: { auth: { code: 'apps/api/src/auth' }, accounts: { code: 'apps/api/src/accounts' }, jobs: { code: 'apps/api/src/jobs' } } },
      data: { parts: { register: { code: 'apps/api/src/db' }, queue: {} } },
    },
    rules: [
      {
        rule: 'one direction',
        check: 'import-order',
        folder: 'apps/api/src',
        'root files': ['worker.ts', 'env.ts'],
        'shared root files': ['env.ts'],
        order: [['http'], ['jobs'], ['connectors'], ['auth'], ['accounts'], ['db'], ['ai', 'embeddings'], ['domain']],
        reason: 'Domain imports nothing.',
        agreed: false,
      },
      { rule: 'one registry', check: 'connector-imports', core: ['apps/api', 'apps/web'], files: ['apps/api/src/connectors/registry.ts'], reason: 'One coupling point.', agreed: false },
      { rule: 'engine lists', check: 'engine-lists', files: ['apps/api/src/engines/list.ts'], reason: 'A seam.', agreed: false },
      { rule: 'no source ids', check: 'source-names', except: { 'apps/api/src/accounts/changes.ts': 'migrations' }, reason: 'Blind core.', agreed: false },
      { rule: 'paid calls', check: 'paid-calls', files: ['apps/api/src/gateway/'], reason: 'Recorded.', agreed: false },
    ],
    accepted: [],
    sources: { gmail: { package: 'packages/connectors/gmail' }, 'claude-code': { engine: true } },
  },
});

/** The same rules as scripts/import-rules.json held them before the rules file. */
const oldJson = () => ({
  sources: { gmail: { package: '@cockpit/connector-gmail' }, 'claude-code': { engine: true } },
  core: ['apps/api', 'apps/web'],
  registry: 'apps/api/src/connectors/registry.ts',
  areas: {
    folder: 'apps/api/src',
    root: ['worker.ts', 'env.ts'],
    sharedRoot: ['env.ts'],
    order: [['http'], ['jobs'], ['connectors'], ['auth'], ['accounts'], ['db'], ['ai', 'embeddings'], ['domain']],
  },
  allowlist: [],
  names: { exempt: ['apps/api/src/accounts/changes.ts'] },
  engines: ['apps/api/src/engines/list.ts'],
});

const manifests = { 'packages/connectors/gmail/package.json': JSON.stringify({ name: '@cockpit/connector-gmail' }) };
const manifestOf = (path) => manifests[path] ?? null;

describe('rule 1: a rule cannot be loosened, whichever file the merge base holds the rules in', () => {
  /** A git that knows a merge base holding exactly these files (path to text). */
  const gitHolding = (files) => (args) => {
    if (args[0] === 'merge-base') return 'basesha';
    if (args[0] === 'cat-file') return '';
    if (args[0] === 'ls-tree') return args[3] in files ? `100644 blob abc\t${args[3]}` : '';
    if (args[0] === 'show') {
      const path = args[1].replace('basesha:', '');
      if (path in files) return files[path];
      throw new Error(`no ${path}`);
    }
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
  const yamlOf = (doc) => JSON.stringify(doc);
  /** What a pull request with this head would be told, against a base holding these files. */
  const compare = (baseFiles, head) => {
    const base = readBase({ event: undefined, ci: false, git: gitHolding({ ...manifests, ...baseFiles }) });
    if (!base.rules) return base;
    const rules = rulesFromFile(head, manifestOf);
    return [...shrinkFailures(rules.allowlist, base.rules.allowlist), ...relaxations(rules, base.rules)];
  };

  it('passes the rules file holding the same rules as the old import rules', () => {
    assert.deepEqual(compare({ 'scripts/import-rules.json': JSON.stringify(oldJson()) }, fileDoc()), []);
  });

  it('fails the rules file with a source removed, naming the source', () => {
    const head = fileDoc();
    delete head.cockpit.sources.gmail;
    const failures = compare({ 'scripts/import-rules.json': JSON.stringify(oldJson()) }, head);
    assert.equal(failures.length, 1);
    assert.match(failures[0], /source gmail was removed/);
  });

  it('fails two areas reordered against a base that already holds the rules file, naming both', () => {
    const head = fileDoc();
    head.cockpit.rules[0].order = [['http'], ['connectors'], ['jobs'], ['auth'], ['accounts'], ['db'], ['ai', 'embeddings'], ['domain']];
    const failures = compare({ 'docs/architecture.yml': yamlOf(fileDoc()) }, head);
    assert.match(failures.join('\n'), /jobs no longer stays above connectors/);
  });

  it('passes a rule set agreed and a reason reworded', () => {
    const head = fileDoc();
    head.cockpit.rules[0].agreed = true;
    head.cockpit.rules[0].reason = 'Said another way.';
    head.cockpit.rules[1].source = 'architecture.md';
    assert.deepEqual(compare({ 'docs/architecture.yml': yamlOf(fileDoc()) }, head), []);
  });

  it('skips, saying why, when the base holds neither file', () => {
    const base = readBase({ event: undefined, ci: false, git: gitHolding({}) });
    assert.equal(base.rules, null);
    assert.match(base.skipped, /neither docs\/architecture\.yml nor scripts\/import-rules\.json/);
  });

  it('reads the old file into the shape the rules file maps to', () => {
    assert.deepEqual(rulesFromOldJson(oldJson()), rulesFromFile(fileDoc(), manifestOf));
  });
});

describe('rule 3: an accepted entry lets through only an import the order forbids, and the list may only shrink', () => {
  const forbidden = { from: 'accounts', to: 'jobs', files: [api('accounts/store.ts')], reason: 'x', agreed: false };
  const withAccepted = (...accepted) => {
    const doc = fileDoc();
    doc.cockpit.accepted = accepted;
    return rulesFromFile(doc, manifestOf);
  };
  const breachesIn = (declared, importer, imported) => findBreaches([{ importer, imported, typeOnly: false }], declared);

  it('passes a forbidden import with an accepted entry for its file', () => {
    const declared = withAccepted(forbidden);
    assert.deepEqual(failuresAgainst(breachesIn(declared, api('accounts/store.ts'), api('jobs/run.ts')), declared.allowlist), []);
  });

  it('fails an accepted forbidden entry whose import is gone, naming the entry to remove', () => {
    const declared = withAccepted(forbidden);
    const failures = failuresAgainst([], declared.allowlist);
    assert.equal(failures.length, 1);
    assert.match(failures[0], /remove it: .*accounts\/store\.ts -> jobs/);
  });

  it('fails a forbidden entry the merge base does not have', () => {
    const declared = withAccepted(forbidden);
    const failures = shrinkFailures(declared.allowlist, withAccepted().allowlist);
    assert.equal(failures.length, 1);
    assert.match(failures[0], /accounts\/store\.ts -> jobs/);
  });

  it('passes an entry the order already allows, which changes nothing', () => {
    const declared = withAccepted({ from: 'auth', to: 'register', files: [api('auth/register.ts')], reason: 'x', agreed: false });
    assert.deepEqual(declared.allowlist, []);
    assert.deepEqual(shrinkFailures(declared.allowlist, []), []);
    assert.deepEqual(failuresAgainst(breachesIn(declared, api('auth/register.ts'), api('db/client.ts')), declared.allowlist), []);
  });
});

describe('rule 4: every rule in the file carries a reason or a question, and an agreed mark', () => {
  it('fails a rule with neither, naming it', () => {
    const doc = fileDoc();
    delete doc.cockpit.rules[1].reason;
    const failures = shapeFailures(doc);
    assert.equal(failures.length, 1);
    assert.match(failures[0], /"one registry" has neither a reason nor a question/);
  });

  it('fails a rule with no agreed mark, naming it', () => {
    const doc = fileDoc();
    delete doc.cockpit.rules[2].agreed;
    const failures = shapeFailures(doc);
    assert.equal(failures.length, 1);
    assert.match(failures[0], /"engine lists" has no agreed mark/);
  });

  it("passes today's file", () => {
    assert.deepEqual(shapeFailures(parseRulesFile(readFileSync(join(repo, 'docs/architecture.yml'), 'utf8'))), []);
  });

  it("reads the paid-call rule's files the same way the checkout-only paid-call check does", () => {
    const text = readFileSync(join(repo, 'docs/architecture.yml'), 'utf8');
    const rule = parseRulesFile(text).cockpit.rules.find((found) => found.check === 'paid-calls');
    assert.deepEqual(paidCallFiles(text), rule.files);
  });
});

describe('rule 5: a rules file that does not parse fails the check, naming the file and the line', () => {
  it('names the file and the line in the error', () => {
    assert.throws(() => parseRulesFile('cockpit:\n  rules: [\n'), /^Error: docs\/architecture\.yml:\d+:/);
  });

  it('fails the tree check with that message', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rules-file-'));
    try {
      mkdirSync(join(dir, 'docs'), { recursive: true });
      writeFileSync(join(dir, 'docs/architecture.yml'), 'cockpit:\n  rules: [\n');
      const [failure, ...rest] = checkTree(dir, { rules: null, skipped: 'test' });
      assert.match(failure, /^docs\/architecture\.yml:\d+:/);
      assert.deepEqual(rest, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the known breaches can only shrink, and accepted calls may grow, from the first merge base that checks the layers', () => {
  const layerCheck = { rule: 'layer calls', check: 'layer-calls', reason: 'Checked.', agreed: false };
  const breach = { from: 'jobs', to: 'queue', files: [api('jobs/enrichment.ts')], question: 'Why?' };
  /** The rules file with the layer-calls rule, these known breaches and these accepted calls. */
  const checked = (known, accepted = []) => {
    const doc = fileDoc();
    doc.cockpit.rules.push(layerCheck);
    doc.cockpit['known breaches'] = known;
    doc.cockpit.accepted = accepted;
    return doc;
  };
  const relaxed = (head, base) => relaxations(rulesFromFile(head, manifestOf), rulesFromFile(base, manifestOf));

  it('passes the layer-calls rule arriving with its known breaches, since the merge base did not check the layers yet', () => {
    assert.deepEqual(relaxed(checked([breach]), fileDoc()), []);
  });

  it('passes a known breach removed, or one of its files removed', () => {
    const two = { ...breach, files: [api('jobs/enrichment.ts'), api('jobs/guest-arrival.ts')] };
    assert.deepEqual(relaxed(checked([breach]), checked([two])), []);
    assert.deepEqual(relaxed(checked([]), checked([two])), []);
  });

  it('fails a known breach the merge base does not have', () => {
    const failures = relaxed(checked([breach, { from: 'http', to: 'register', files: [api('http/app.ts')], question: 'Why?' }]), checked([breach]));
    assert.deepEqual(failures, ["known breach is not in the merge base's known breaches, the list may only shrink: http -> register in apps/api/src/http/app.ts"]);
  });

  it('fails a known breach spreading to one more file', () => {
    const failures = relaxed(checked([{ ...breach, files: [...breach.files, api('jobs/new.ts')] }]), checked([breach]));
    assert.deepEqual(failures, ["known breach is not in the merge base's known breaches, the list may only shrink: jobs -> queue in apps/api/src/jobs/new.ts"]);
  });

  it('passes an accepted call added with its reason, the pull request being its review', () => {
    const accepted = { from: 'http', to: 'register', files: [api('http/app.ts')], reason: 'Read before an account is known.', agreed: false };
    assert.deepEqual(relaxed(checked([breach], [accepted]), checked([breach])), []);
  });

  it('fails the layer-calls rule removed', () => {
    const head = checked([breach]);
    head.cockpit.rules = head.cockpit.rules.filter((rule) => rule.check !== 'layer-calls');
    assert.deepEqual(relaxed(head, checked([breach])), ['the rule with check: layer-calls was removed']);
  });
});
