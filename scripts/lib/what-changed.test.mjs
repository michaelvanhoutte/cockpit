//
// Two halves, and both are needed. The first proves the classifier tells a
// documentation-only diff from every other kind, against path lists written
// here, and that every way its I/O can fail still says "product changed" and
// "security". The second reads the workflow files and the classifier action
// they share, which is the half
// that gates: the classifier is only worth anything if the jobs actually
// consult it, and a job added or an output renamed would otherwise be found
// by a pull request that skipped its own checks.
//

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import {
  changeClass,
  classify,
  diffRange,
  isNonProduct,
  isSecurityPath,
  isStoredDataPath,
  localChangeAnswer,
  pathsFromDiff,
  printable,
  productChanged,
  productPaths,
  widgetChanged,
} from './what-changed.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '../..');
const workflow = (name) => readFileSync(join(repo, '.github/workflows', name), 'utf8');

/** The same, but `null` rather than a failure where there is no such job. */
function jobIfAny(yaml, id) {
  const lines = yaml.split('\n');
  const start = lines.indexOf(`  ${id}:`);
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^ {2}\S/.test(line));
  return rest.slice(0, end === -1 ? rest.length : end).join('\n');
}

/** One job's own lines, from its key down to whatever comes next at that indent. */
function job(yaml, id) {
  const block = jobIfAny(yaml, id);
  assert.notEqual(block, null, `${id} is not a job here`);
  return block;
}

/**
 * A workflow's `on:` block, whole-line comments dropped. They are dropped
 * because these files explain their own triggers at length, so a whole-file
 * match for `pull_request` would answer on the prose rather than on the
 * trigger. Dropped *before* the block's end is found, not after: a comment at
 * column zero is ordinary YAML style and would otherwise end the block early,
 * hiding whatever follows it from the assertions - which is the one way this
 * could pass over a restored trigger rather than fail over prose. A comment
 * trailing a trigger on its own line survives, so nothing here anchors on the
 * end of a line.
 */
function triggersOf(yaml) {
  const lines = yaml.split('\n');
  const start = lines.indexOf('on:');
  assert.notEqual(start, -1, 'this workflow declares no triggers at all');
  const rest = lines.slice(start + 1).filter((line) => !/^\s*#/.test(line));
  // A sequence item may sit at the key's own indent, so `- cron:` at column
  // zero is still inside the block rather than the start of the next one.
  const end = rest.findIndex((line) => /^[^\s-]/.test(line));
  return rest.slice(0, end === -1 ? rest.length : end).join('\n');
}

/**
 * The jobs a block declares it waits for, in any of the three shapes YAML
 * allows. Matching `/needs: changes/` alone would read `needs: [changes, x]`
 * as no dependency at all, so a job could gain the gate - or lose it - without
 * either assertion below noticing. Shared by every describe below that reads a
 * workflow file, rather than redeclared per block, once a second one needed it
 * too.
 */
function needsOf(block) {
  const declaration = block.match(/^ {4}needs:[^\S\n]*(.*)$/m);
  if (!declaration) return [];
  const value = declaration[1].trim();
  if (value !== '') {
    return value
      .replace(/^\[/, '')
      .replace(/\]$/, '')
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id !== '');
  }
  const following = block.slice(declaration.index + declaration[0].length).split('\n').slice(1);
  const items = [];
  for (const line of following) {
    const item = line.match(/^ {6}- (.+)$/);
    if (!item) break;
    items.push(item[1].trim());
  }
  return items;
}

/** A commit the way GitHub writes one. */
const sha = (char) => char.repeat(40);

/** Written by code point, so no test file ever carries a raw control byte. */
const NUL = String.fromCharCode(0);
const NEWLINE = String.fromCharCode(10);

describe('productChanged', () => {
  it('skips the mechanical jobs on a diff of documentation and agent instructions alone', () => {
    const paths = ['docs/architecture.md', 'docs/deployment.md', '.claude/skills/testing/SKILL.md', '.claude/settings.json', 'CLAUDE.md', 'readme.md'];
    assert.equal(productChanged(paths), false);
    for (const path of paths) assert.equal(isNonProduct(path), true, `${path} should be non-product`);
  });

  it('runs them on a mixed diff, whichever part of the product it touches', () => {
    for (const path of [
      'apps/web/src/main.tsx',
      'packages/shared/src/commands.ts',
      'tools/test-explorer/src/cli.js',
      'scripts/dev.mjs',
      'tests/e2e/panels.test.ts',
      'apps/api/migrations/0007_add_items.sql',
    ]) {
      assert.equal(productChanged(['docs/architecture.md', path]), true, `${path} should force the full suite`);
      assert.deepEqual(productPaths(['docs/architecture.md', path]), [path]);
    }
  });

  it('runs them on a workflow or action change, whatever else the diff touches', () => {
    for (const path of ['.github/workflows/ci.yml', '.github/workflows/codeql.yml', '.github/actions/setup/action.yml', '.github/branch-protection.json']) {
      assert.equal(productChanged(['CLAUDE.md', 'docs/deployment.md', path]), true, `${path} should force the full suite`);
    }
  });

  it('runs them on a lockfile or a config file on its own', () => {
    for (const path of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.json', 'playwright.config.ts', 'eslint.config.mjs', 'apps/api/wrangler.jsonc']) {
      assert.equal(productChanged([path]), true, `${path} should force the full suite`);
    }
  });

  it('runs them on a diff it could read nothing from, since that is not the same as a documentation change', () => {
    assert.equal(productChanged([]), true);
    assert.equal(productChanged(['', '  ']), true);
    assert.equal(productChanged(undefined), true);
  });

  it('does not let trimming turn a path into one it does not start with', () => {
    // A legal filename may open with a control character `git diff -z` hands
    // over intact; classifying a trimmed copy of it would read
    // `\ndocs/evil.ts` as starting with `docs/`, when the real path does not.
    for (const path of [`${NEWLINE}docs/evil.ts`, '  docs/evil.ts', `${NEWLINE}CLAUDE.md`]) {
      assert.equal(isNonProduct(path), false, `${JSON.stringify(path)} should not be read as documentation`);
      assert.equal(productChanged([path]), true, `${JSON.stringify(path)} should force the full suite`);
    }
  });

  it('does not let a blank entry vanish from a mixed diff instead of forcing the suite', () => {
    // A whitespace-only path is a real path exactly as much as any other, and
    // isNonProduct answers "product" for one - dropping it before that answer
    // ever runs used to erase it from the diff instead, so a docs-only-looking
    // change carrying one silently skipped everything rather than running it.
    assert.equal(isNonProduct('  '), false, 'a blank entry should read as product on its own');
    assert.equal(productChanged(['docs/a.md', '  ']), true, 'a blank entry should still force the suite alongside a real docs change');
    assert.deepEqual(productPaths(['docs/a.md', '  ']), ['  ']);
  });

  it('runs them on a path that only looks like documentation', () => {
    // Prefixes are exact and case-sensitive, and Markdown is only prose when it
    // sits at the root: everything else falls through to the product, which is
    // the direction that costs a run rather than a merge.
    for (const path of ['docsite/index.html', '.claude-plugin/marketplace.json', 'Docs/architecture.md', 'tools/test-explorer/readme.md']) {
      assert.equal(productChanged([path]), true, `${path} should force the full suite`);
    }
  });

  it('answers the same question the run log answers, so the two cannot disagree', () => {
    for (const paths of [['docs/a.md'], ['docs/a.md', 'apps/web/src/main.tsx'], ['apps/web/src/main.tsx'], [], ['  ']]) {
      // Mirrors productChanged's own definition exactly - no trim-based
      // emptiness test of its own, which is the shape the blank-path bug
      // this file also guards against took.
      const empty = paths.length === 0;
      assert.equal(productChanged(paths), empty || productPaths(paths).length > 0, `${JSON.stringify(paths)} is answered two ways`);
    }
  });
});

describe('changeClass', () => {
  // The packages a working tree's own paths get attributed to - the same
  // shape scripts/lib/workspace.mjs's testablePackages discovers, standing in
  // for it the way this file's other describes stand in for a real diff.
  const packages = [
    { name: '@cockpit/api', dir: 'apps/api' },
    { name: '@cockpit/web', dir: 'apps/web' },
  ];

  // A loop rather than a table helper: node:test has no `it.each`, the same
  // reason backup.test.mjs and health.test.mjs give beside their own. The
  // seven situations are the statement list "Review a change as much as what
  // it touches needs, and recheck only what a fix changed" (issue 423) drew
  // up for this rule.
  for (const { situation, paths, want } of [
    {
      situation: 'uncommitted and committed changes on a branch, all under docs/',
      paths: ['docs/architecture.md', 'docs/deployment.md'],
      want: { class: 'docs' },
    },
    {
      situation: "only deleted or changed files under a package's tests/",
      paths: ['apps/api/tests/unit/commands.test.ts', 'apps/api/tests/integration/http/item-changes.test.ts'],
      want: { class: 'tests', packages: ['@cockpit/api'] },
    },
    {
      situation: 'app code on neither the security nor the stored-data list',
      paths: ['docs/architecture.md', 'apps/web/src/main.tsx'],
      want: { class: 'product', security: false, storedData: false },
    },
    {
      situation: 'a migration, on its own',
      paths: ['apps/api/migrations/0007_add_items.sql'],
      want: { class: 'product', security: false, storedData: true },
    },
    {
      situation: 'either schema file, or the account store\'s change list',
      paths: ['apps/api/src/accounts/schema.ts', 'apps/api/src/db/schema.ts', 'apps/api/src/accounts/changes.ts'],
      want: { class: 'product', security: false, storedData: true },
    },
    {
      situation: "sign-in code, the web session, a connector, the user register, backup, restore or the guest account's reset",
      paths: [
        'apps/api/src/auth/session.ts',
        'apps/web/src/session/forget.ts',
        'apps/api/src/connectors/registry.ts',
        'apps/api/src/accounts/register.ts',
        'apps/api/src/accounts/backup.ts',
        'apps/api/src/accounts/restore.ts',
        'scripts/guest-reset.mjs',
      ],
      want: { class: 'product', security: true, storedData: true },
    },
    {
      situation: 'a workflow, the branch-protection payload, the composite action or Wrangler\'s configuration, none of them stored data',
      paths: ['.github/workflows/ci.yml', '.github/branch-protection.json', '.github/actions/setup/action.yml', 'apps/api/wrangler.jsonc'],
      want: { class: 'product', security: true, storedData: false },
    },
    {
      situation: 'a schema file and a workflow together',
      paths: ['apps/api/src/db/schema.ts', '.github/workflows/ci.yml'],
      want: { class: 'product', security: true, storedData: true },
    },
    {
      situation: 'a path this could not read at all',
      paths: [],
      want: { class: 'product', security: true, storedData: true },
    },
  ]) {
    it(`answers ${situation}`, () => {
      assert.deepEqual(changeClass({ paths, packages }), want);
    });
  }
});

describe('isSecurityPath and isStoredDataPath', () => {
  it('answer false for an ordinary product path', () => {
    assert.equal(isSecurityPath('apps/web/src/main.tsx'), false);
    assert.equal(isStoredDataPath('apps/web/src/main.tsx'), false);
  });

  it('match a directory prefix, not a path that merely starts with the same letters', () => {
    // apps/api/src/auth/session.ts is security; apps/api/src/auth-helpers.ts
    // is not the same directory and should not match its prefix by accident.
    assert.equal(isSecurityPath('apps/api/src/auth/session.ts'), true);
    assert.equal(isSecurityPath('apps/api/src/auth-helpers.ts'), false);
  });

  it('match an exact file rather than every file beside it', () => {
    assert.equal(isSecurityPath('apps/api/src/accounts/register.ts'), true);
    assert.equal(isSecurityPath('apps/api/src/accounts/new-user.ts'), false);
    assert.equal(isStoredDataPath('apps/api/src/accounts/schema.ts'), true);
    assert.equal(isStoredDataPath('apps/api/src/accounts/probe.ts'), false);
  });

  it('carry backup, restore and the guest reset on both lists', () => {
    for (const path of ['apps/api/src/accounts/backup.ts', 'apps/api/src/accounts/restore.ts', 'scripts/guest-reset.mjs']) {
      assert.equal(isSecurityPath(path), true, `${path} should be a security path`);
      assert.equal(isStoredDataPath(path), true, `${path} should be a stored-data path`);
    }
  });

  it('calls the sign-in gate composition security, and the account store stored data', () => {
    // Found by /security-review on this very issue: the allowlists above
    // originally named auth/, the register and the schema files but missed
    // the two files that actually run every request and every row through
    // them.
    assert.equal(isSecurityPath('apps/api/src/http/app.ts'), true, 'the gate composition, the OIDC callback and the ingress dispatcher all live here');
    assert.equal(isStoredDataPath('apps/api/src/accounts/store.ts'), true, "the Durable Object every account's rows are actually read and written through");
  });

  it('calls the Android widget security, since it keeps a sign-in token on a phone', () => {
    assert.equal(isSecurityPath('apps/android-widget/app/src/main/java/com/conselit/cockpit/widget/Storage.kt'), true);
    assert.equal(isStoredDataPath('apps/android-widget/app/src/main/java/com/conselit/cockpit/widget/Storage.kt'), false);
    assert.equal(isSecurityPath('apps/android-widget-notes/x.kt'), false, 'a neighbour that merely starts with the same letters');
  });

  it('calls its own classifier security, so a change that weakens it cannot classify itself out of review', () => {
    // A change to the classifier itself has to be on this list, or it would
    // classify itself as harmless and skip the one review that would have
    // caught it - the local `/security-review` Review findings' table asks
    // for, since "Remove the remote code and security reviews".
    // local-changes.mjs is on it because that removal left it the only
    // reader of the security answer: weaken it and nothing else notices.
    for (const path of [
      'scripts/lib/what-changed.mjs',
      'scripts/what-changed.mjs',
      'scripts/local-changes.mjs',
      '.github/actions/setup/action.yml',
    ]) {
      assert.equal(isSecurityPath(path), true, `${path} decides or asserts the verdict and should be a security path`);
    }
  });
});

describe('widgetChanged', () => {
  it('is true for the app, the sample answers its tests read, and the workflow that runs them', () => {
    for (const path of [
      'apps/android-widget/app/build.gradle.kts',
      'apps/android-widget/gradlew',
      'packages/shared/samples/panel-read.sample.json',
      '.github/workflows/ci.yml',
    ]) {
      assert.equal(widgetChanged([path]), true, `${path} can change what the widget's tests say`);
    }
  });

  it('is false for a diff that touches nothing the widget reads, product code included', () => {
    assert.equal(widgetChanged(['apps/web/src/main.tsx', 'apps/api/src/mcp/panel-reads.ts', 'docs/deployment.md', 'packages/shared/src/index.ts']), false);
    assert.equal(widgetChanged(['apps/android-widget-notes/x.kt']), false, 'a neighbour that merely starts with the same letters');
  });

  it('is true for one path among others, and for a diff it could not read', () => {
    assert.equal(widgetChanged(['docs/a.md', 'apps/android-widget/settings.gradle.kts']), true);
    assert.equal(widgetChanged([]), true);
    assert.equal(widgetChanged(undefined), true);
  });
});

describe('localChangeAnswer', () => {
  const packages = [
    { name: '@cockpit/api', dir: 'apps/api' },
    { name: '@cockpit/web', dir: 'apps/web' },
  ];

  /** A `packages` thunk that fails the test if scripts/local-changes.mjs's own short-circuit ever calls it. */
  const mustNotBeCalled = () => assert.fail('localChangeAnswer asked for the workspace on a diff that never needed it');

  it("never asks for the workspace on a documentation-only diff - the pnpm -r list a docs-only push has no reason to pay for", () => {
    const paths = ['docs/deployment.md', 'docs/testing-strategy.md'];
    assert.equal(localChangeAnswer(paths, mustNotBeCalled), 'documentation only');
  });

  it('names the package a test-only diff belongs to', () => {
    const paths = ['apps/api/tests/unit/commands.test.ts'];
    assert.equal(localChangeAnswer(paths, () => packages), 'tests only (@cockpit/api)');
  });

  it('answers product changed on a mix of docs and product paths, without needing to ask why', () => {
    const paths = ['docs/deployment.md', 'apps/web/src/main.tsx'];
    assert.equal(localChangeAnswer(paths, () => packages), 'product changed');
  });

  it('tags stored data, security, or both, onto a product change that touches either list', () => {
    assert.equal(localChangeAnswer(['apps/api/src/accounts/schema.ts'], () => packages), 'product changed (stored data)');
    assert.equal(localChangeAnswer(['apps/api/src/auth/session.ts'], () => packages), 'product changed (security)');
    assert.equal(localChangeAnswer(['apps/api/src/accounts/backup.ts'], () => packages), 'product changed (security, stored data)');
  });

  describe('a change to the architecture document', () => {
    const named = 'docs/architecture.md changed: the issue\'s Technical design must have decided it, or the engineer agrees it before the push.';

    it('is named beside "documentation only" when it is all that changed', () => {
      assert.equal(localChangeAnswer(['docs/architecture.md'], mustNotBeCalled), `documentation only\n${named}`);
    });

    it('is named beside the product answer when product code changed with it', () => {
      assert.equal(localChangeAnswer(['docs/architecture.md', 'apps/web/src/main.tsx'], () => packages), `product changed\n${named}`);
    });

    it('is named, and the answer still the safe one, where the workspace could not be read', () => {
      const unreadable = () => {
        throw new Error('pnpm -r list failed: exit 1');
      };
      assert.equal(localChangeAnswer(['docs/architecture.md', 'apps/web/src/main.tsx'], unreadable), `product changed (security, stored data)\n${named}`);
    });

    it('is not mentioned where it did not change', () => {
      assert.equal(localChangeAnswer(['docs/deployment.md'], mustNotBeCalled), 'documentation only');
      assert.equal(localChangeAnswer(['apps/web/src/main.tsx'], () => packages), 'product changed');
    });

    it('is named when deleted or renamed, which the diff reports as the old path alone and the new one added', () => {
      assert.ok(localChangeAnswer(['docs/architecture.md'], mustNotBeCalled).endsWith(named), 'a deletion');
      assert.ok(localChangeAnswer(['docs/architecture.md', 'docs/design/architecture.md'], mustNotBeCalled).endsWith(named), 'a rename');
    });

    it('starts with one of the review table rows, whatever else the change is', () => {
      const rows = /^(documentation only|tests only \(.+\)|product changed( \((security|stored data|security, stored data)\))?)$/;
      for (const paths of [['docs/architecture.md'], ['docs/architecture.md', 'apps/api/tests/unit/commands.test.ts'], ['docs/architecture.md', 'apps/api/src/auth/session.ts']]) {
        const [first] = localChangeAnswer(paths, () => packages).split('\n');
        assert.match(first, rows);
      }
    });
  });

  it('answers product changed, security and stored data, on an empty diff, agreeing with changeClass rather than reading it as documentation', () => {
    // paths.length is 0, not > 0 - the one case the docs-only short-circuit
    // deliberately excludes (scripts/local-changes.mjs's own comment on it),
    // so this still asks for the workspace.
    let asked = false;
    assert.equal(
      localChangeAnswer([], () => {
        asked = true;
        return packages;
      }),
      'product changed (security, stored data)',
    );
    assert.equal(asked, true, 'an empty diff should still consult changeClass, not shortcut past it');
  });

  it('answers product changed, security and stored data - the safe direction - where the workspace could not be read', () => {
    const paths = ['apps/web/src/main.tsx'];
    assert.equal(
      localChangeAnswer(paths, () => {
        throw new Error('pnpm -r list failed: exit 1');
      }),
      'product changed (security, stored data)',
    );
  });
});

describe('diffRange', () => {
  it('asks a pull request for what the branch added, not for what main has moved on by', () => {
    const range = diffRange({
      eventName: 'pull_request',
      event: { pull_request: { base: { sha: sha('a') }, head: { sha: sha('b') } } },
    });
    assert.equal(range, `${sha('a')}...${sha('b')}`);
  });

  it('asks a push to main for the commits that merge brought in', () => {
    const range = diffRange({ eventName: 'push', event: { before: sha('c'), after: sha('d') } });
    assert.equal(range, `${sha('c')}..${sha('d')}`);
  });

  it('gives up on a push with no earlier commit to diff against', () => {
    assert.equal(diffRange({ eventName: 'push', event: { before: sha('0'), after: sha('d') } }), null);
  });

  it('gives up on anything that is not a pair of commits, rather than guessing a range', () => {
    assert.equal(diffRange({ eventName: 'workflow_dispatch', event: { after: sha('d') } }), null);
    assert.equal(diffRange({ eventName: 'push', event: {} }), null);
    assert.equal(diffRange({ eventName: 'pull_request', event: { pull_request: { base: { sha: 'main' }, head: { sha: sha('b') } } } }), null);
    assert.equal(diffRange({ eventName: 'pull_request', event: {} }), null);
    assert.equal(diffRange(), null);
  });
});

describe('pathsFromDiff', () => {
  it('reads the NUL-separated names git prints, so a space in one is not two paths', () => {
    assert.deepEqual(pathsFromDiff(`docs/a b.md${NUL}apps/web/src/main.tsx${NUL}`), ['docs/a b.md', 'apps/web/src/main.tsx']);
    assert.deepEqual(pathsFromDiff(''), []);
    assert.deepEqual(pathsFromDiff(undefined), []);
  });
});

describe('printable', () => {
  it('flattens the control characters a path may legally carry', () => {
    assert.equal(printable(`a${NUL}b`), 'a?b');
    // Carriage return, tab, escape and delete, which is every other shape a
    // command injected into the log could take.
    assert.equal(printable(String.fromCharCode(13, 9, 27, 127)), '????');
  });

  it('breaks up a workflow command even where it sits at the start of a printed path', () => {
    // Flattening the newline stops a path from opening a new log line, but
    // every printed line already starts with a two-space indent, so a runner
    // that trims leading whitespace before matching a command would still read
    // one sitting right after it, so every `::` is broken up as well.
    assert.equal(printable(`apps/x.ts${NEWLINE}::stop-commands::4f1a`), 'apps/x.ts?: :stop-commands: :4f1a');
    assert.equal(printable('::error::forged'), ': :error: :forged');
  });

  it('leaves an ordinary path, and anything not a string, alone', () => {
    assert.equal(printable('apps/api/src/index.ts'), 'apps/api/src/index.ts');
    assert.equal(printable('docs/a b.md'), 'docs/a b.md');
    assert.equal(printable('docs/décor.md'), 'docs/décor.md');
    assert.equal(printable(undefined), '');
    assert.equal(printable(null), '');
  });
});

describe('classify', () => {
  const eventPath = '/github/workflow/event.json';

  /** The runner's two readers, each replaceable by one that fails. */
  const readers = ({ event = {}, diff = '', failRead = false, failDiff = false } = {}) => ({
    eventName: 'pull_request',
    eventPath,
    readFile: (path) => {
      if (failRead) throw new Error(`ENOENT: no such file or directory, open '${path}'`);
      return typeof event === 'string' ? event : JSON.stringify(event);
    },
    gitDiff: () => {
      if (failDiff) throw new Error(`fatal: bad object${NEWLINE}::error::not really`);
      return diff;
    },
  });

  const pullRequest = { pull_request: { base: { sha: sha('a') }, head: { sha: sha('b') } } };

  it('says a documentation-only pull request changed nothing the checks read, and needs no security review', () => {
    const { changed, security, lines } = classify(readers({ event: pullRequest, diff: `docs/a.md${NUL}CLAUDE.md${NUL}` }));
    assert.equal(changed, false);
    assert.equal(security, false);
    assert.match(lines[0], /2 path\(s\) changed, 0 of them product\./);
  });

  it('names the product paths that made the suite run, and stops naming at twenty', () => {
    const many = Array.from({ length: 25 }, (unused, index) => `apps/web/src/f${index}.ts`);
    const { changed, security, lines } = classify(readers({ event: pullRequest, diff: `${many.join(NUL)}${NUL}` }));
    assert.equal(changed, true);
    assert.equal(security, false, 'none of these paths are on the security list');
    assert.equal(lines.filter((line) => line.startsWith('  apps/')).length, 20);
    assert.equal(lines.at(-1), '  ... and 5 more');
  });

  it('flags security wherever a product path in the diff is one', () => {
    const { changed, security } = classify(readers({ event: pullRequest, diff: `apps/web/src/main.tsx${NUL}apps/api/src/auth/session.ts${NUL}` }));
    assert.equal(changed, true);
    assert.equal(security, true);
  });

  it('says why it ran everything on a range with nothing in it, rather than "0 of them product"', () => {
    // productChanged([]) is true, not false - a range git resolved to no
    // files is not the same claim as "found only documentation", and the log
    // line has to say which one happened.
    const { changed, security, lines } = classify(readers({ event: pullRequest, diff: '' }));
    assert.equal(changed, true);
    assert.equal(security, true, 'a diff this could not read is the "path it cannot read" case, answered security');
    assert.equal(lines.length, 1);
    assert.doesNotMatch(lines[0], /0 of them product/);
    assert.match(lines[0], /no paths in this diff/);
  });

  it('says whether the Android widget is touched, beside whether the product is', () => {
    const widget = classify(readers({ event: pullRequest, diff: `apps/android-widget/app/build.gradle.kts${NUL}docs/a.md${NUL}` }));
    assert.equal(widget.widget, true);
    assert.equal(widget.changed, true);
    const web = classify(readers({ event: pullRequest, diff: `apps/web/src/main.tsx${NUL}` }));
    assert.equal(web.widget, false);
    assert.equal(web.changed, true);
  });

  it('runs the widget as well wherever it ran everything', () => {
    for (const result of [
      classify(readers({ event: pullRequest, diff: '' })),
      classify(readers({ event: pullRequest, failDiff: true })),
      classify(readers({ failRead: true })),
      classify(),
    ]) {
      assert.equal(result.widget, true);
    }
  });

  it('runs everything when git could not answer, and says so as a warning', () => {
    const { changed, security, lines } = classify(readers({ event: pullRequest, failDiff: true }));
    assert.equal(changed, true);
    assert.equal(security, true);
    assert.match(lines[0], /^::warning::Could not diff /);
    assert.equal(lines.length, 1);
  });

  it('runs everything when there is no event payload to read', () => {
    const { changed, security, lines } = classify(readers({ failRead: true }));
    assert.equal(changed, true);
    assert.equal(security, true);
    assert.match(lines[0], /^No diff range for a pull_request event/);
  });

  it('runs everything when the event payload is not the JSON it should be', () => {
    for (const event of ['', 'not json at all', '[]']) {
      const { changed, security } = classify(readers({ event }));
      assert.equal(changed, true, `a payload of ${JSON.stringify(event)} should run everything`);
      assert.equal(security, true, `a payload of ${JSON.stringify(event)} should need a security review too`);
    }
  });

  it('runs everything on an event it has no range for', () => {
    const { changed, security, lines } = classify({ ...readers({ event: pullRequest }), eventName: 'schedule' });
    assert.equal(changed, true);
    assert.equal(security, true);
    assert.match(lines[0], /^No diff range for a schedule event/);
    assert.equal(classify().changed, true);
    assert.equal(classify().security, true);
  });

  it('prints no line a runner would read as a workflow command of its own', () => {
    // A path may hold a newline, and `git diff -z` hands it over intact - so
    // `apps/x.ts` and a `::stop-commands::` on the line after it is one file
    // name, and printing it raw would silence the rest of the job's log.
    const nasty = `apps/x.ts${NEWLINE}::stop-commands::4f1a`;
    const printed = [
      ...classify(readers({ event: pullRequest, diff: `${nasty}${NUL}` })).lines,
      ...classify(readers({ event: pullRequest, failDiff: true })).lines,
    ];
    for (const line of printed) {
      assert.ok(!line.includes(NEWLINE), `a printed line carried a newline: ${JSON.stringify(line)}`);
      assert.ok(!line.includes(String.fromCharCode(13)), `a printed line carried a carriage return: ${JSON.stringify(line)}`);
    }
  });
});

describe('the mechanical checks', () => {
  const stepGate = "if: ${{ !cancelled() && steps.classify.outputs.product_changed != 'false' }}";

  /** One named step's own lines, from its `- name:` down to the next step at that indent. */
  function stepNamed(jobBlock, name) {
    const lines = jobBlock.split('\n');
    const start = lines.findIndex((line) => line.trim() === `- name: ${name}`);
    assert.notEqual(start, -1, `no step named ${name} here`);
    const rest = lines.slice(start + 1);
    const end = rest.findIndex((line) => /^ {6}- /.test(line));
    return [lines[start], ...rest.slice(0, end === -1 ? rest.length : end)].join('\n');
  }

  it('reads a dependency in every shape a workflow file may write one', () => {
    assert.deepEqual(needsOf('    needs: changes\n    runs-on: x'), ['changes']);
    assert.deepEqual(needsOf('    needs: [test-explorer, changes]\n    runs-on: x'), ['test-explorer', 'changes']);
    assert.deepEqual(needsOf('    needs:\n      - test-explorer\n      - changes\n    runs-on: x'), ['test-explorer', 'changes']);
    assert.deepEqual(needsOf('    runs-on: x'), []);
  });

  const classifier = readFileSync(join(repo, '.github/actions/classify/action.yml'), 'utf8');
  const useClassifier = 'uses: ./.github/actions/classify';

  /** The steps of a job that follow its classifier step, each as its own lines. */
  function stepsAfterClassifier(jobBlock) {
    const lines = jobBlock.split('\n');
    const at = lines.findIndex((line) => line.trim() === useClassifier);
    assert.notEqual(at, -1, 'this job does not run the classifier');
    const rest = lines.slice(at + 1);
    const starts = rest.flatMap((line, index) => (/^ {6}- /.test(line) ? [index] : []));
    return starts.map((start, index) => rest.slice(start, starts[index + 1] ?? rest.length).join('\n'));
  }

  it('consult what changed, since a skipped step or job is what a required check accepts', () => {
    const yaml = workflow('ci.yml');
    assert.match(classifier, /product_changed:\s+description:.*\s+value: \$\{\{ steps\.classify\.outputs\.product_changed \}\}/, 'the classifier action publishes no answer');
    assert.match(classifier, /node scripts\/what-changed\.mjs/, 'the classifier action does not run the classifier on a push');
    assert.match(classifier, /node "\$base\/what-changed\.mjs"/, "the classifier action does not run the base commit's own copy");
    for (const id of ['checks', 'test', 'e2e']) assert.ok(job(yaml, id).includes(useClassifier), `ci.yml's ${id} job does not run the classifier`);
    const checks = job(yaml, 'checks');
    for (const step of ['Typecheck', 'Lint', 'Verify the lint config', 'Build']) {
      assert.ok(stepNamed(checks, step).includes(stepGate), `checks' ${step} step does not carry the gate: ${stepGate}`);
    }
    // Bundle budget reads `apps/web/dist`, so it is gated on Build's own
    // outcome rather than the classifier a second time - `!= 'false'` would
    // run it against a missing or stale build after a real Build failure.
    assert.match(
      stepNamed(checks, 'Bundle budget'),
      /if: \$\{\{ !cancelled\(\) && steps\.build\.outcome == 'success' \}\}/,
      "checks' Bundle budget step does not gate on Build's own outcome",
    );
  });

  it('skip every step of a shard or Test on a documentation-only diff, so no Chromium is installed', () => {
    const yaml = workflow('ci.yml');
    for (const id of ['test', 'e2e']) {
      const steps = stepsAfterClassifier(job(yaml, id));
      assert.ok(steps.length >= 3, `${id} has too few steps after its classifier to be real`);
      for (const step of steps) {
        // A failure step only fires after a gated step failed, so it cannot fire on a skip.
        if (step.includes('Upload failure artefacts')) continue;
        assert.match(step, /if: .*steps\.classify\.outputs\.product_changed != 'false'/, `ci.yml's ${id} job has a step that runs on a documentation-only diff:\n${step}`);
      }
    }
    // Test Explorer needs Test and now sees a green job on such a diff, so it asks Test's answer itself.
    assert.match(job(yaml, 'test-explorer'), /if: \$\{\{ success\(\) && needs\.test\.outputs\.product_changed != 'false' \}\}/, 'Test Explorer would run on a documentation-only diff');
    assert.match(job(yaml, 'test'), /product_changed: \$\{\{ steps\.classify\.outputs\.product_changed \}\}/, 'Test publishes no answer for Test Explorer');
  });

  it('build the Android widget only when something it reads changed, and run it where the classifier said nothing', () => {
    const yaml = workflow('ci.yml');
    assert.match(classifier, /widget_changed:\s+description:.*\s+value: \$\{\{ steps\.classify\.outputs\.widget_changed \}\}/, 'the classifier action publishes no answer for the widget');
    assert.match(readFileSync(join(repo, 'scripts/what-changed.mjs'), 'utf8'), /widget_changed=\$\{widget\}/, 'the classifier writes no answer for the widget');
    const widget = job(yaml, 'widget');
    assert.ok(widget.includes(useClassifier), "ci.yml's widget job does not run the classifier");
    assert.deepEqual(needsOf(widget), [], "ci.yml's widget job waits for another");
    const steps = stepsAfterClassifier(widget);
    assert.ok(steps.length >= 3, 'the widget job has too few steps after its classifier to be real');
    for (const step of steps) {
      // A failure step only fires after a gated step failed, so it cannot fire on a skip.
      if (step.includes('Upload the test and lint reports')) continue;
      assert.match(step, /if: .*steps\.classify\.outputs\.widget_changed != 'false'/, `ci.yml's widget job has a step that runs on a diff the widget does not read:\n${step}`);
    }
    assert.match(widget, /gradlew --no-daemon test /, 'the widget job runs no tests');
  });

  it('cut the widget release on a tag, from the four secrets, and from nothing else', () => {
    const release = workflow('widget-release.yml');
    const on = triggersOf(release);
    assert.match(on, /tags: \['widget-v\*'\]/, 'the release is not cut by a widget-v tag');
    assert.doesNotMatch(on, /pull_request|branches/, 'the release must not run for a branch or a pull request');
    for (const secret of ['WIDGET_KEYSTORE_BASE64', 'WIDGET_KEYSTORE_PASSWORD', 'WIDGET_KEY_ALIAS', 'WIDGET_KEY_PASSWORD']) {
      assert.ok(release.includes(`secrets.${secret}`), `the release never reads ${secret}`);
    }
    assert.match(release, /permissions:\n {2}contents: read/, 'the workflow should be read-only by default');
    assert.match(job(release, 'release'), /permissions:\n {6}contents: write/, 'only the release job may write the release');
  });

  it('start Test and the shards with the run, not when Checks ends', () => {
    const yaml = workflow('ci.yml');
    for (const id of ['checks', 'test', 'e2e']) assert.deepEqual(needsOf(job(yaml, id)), [], `ci.yml's ${id} job waits for another`);
    for (const id of ['test', 'e2e']) assert.doesNotMatch(job(yaml, id), /\$\{\{[^}]*needs\./, `ci.yml's ${id} job reads another job's output`);
  });

  it('decide from the base commit, so a branch cannot rule on its own diff', () => {
    // `pull_request` builds the merge ref, so the classifier in the tree is the
    // one this branch wrote. Running it would let a diff answer "documentation
    // only" about its own payload and skip every check that would have read it.
    assert.match(classifier, /BASE_SHA: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/, 'the base commit is never named');
    assert.match(classifier, /git show "\$BASE_SHA:scripts\/what-changed\.mjs"/, "the base commit's own wrapper is not taken");
    assert.match(classifier, /git show "\$BASE_SHA:scripts\/lib\/what-changed\.mjs"/, "the base commit's own module is not taken");
  });

  it('names every local file the base-commit extraction would need to copy too', () => {
    // ci.yml's `git show` pair is two hard-coded paths, not a general copy of
    // whatever the wrapper imports - so a third local file added to either
    // module later would leave the extraction reading a wrapper that cannot
    // resolve its own import, `continue-on-error` turning that crash into a
    // silent "every check runs" rather than a loud one. This is the tripwire,
    // for both files the extraction copies: the wrapper's one local import
    // fails the moment a second is added, and the module's own zero fails the
    // moment it gains any - either is when ci.yml needs a third `git show`.
    const localImportsOf = (path) => {
      const source = readFileSync(join(repo, path), 'utf8');
      return [...source.matchAll(/from '(\.[^']+)'/g)].map((match) => match[1]);
    };
    assert.deepEqual(localImportsOf('scripts/what-changed.mjs'), ['./lib/what-changed.mjs']);
    assert.deepEqual(localImportsOf('scripts/lib/what-changed.mjs'), []);
  });

  it('never falls back to the pull request\'s own classifier when the base commit has none', () => {
    // A pull request whose base predates this classifier - every branch open
    // when it merges, until each is rebased - would otherwise hit exactly the
    // fallback the base-commit extraction exists to prevent: running the
    // branch's own copy, which a tampered one could answer "documentation
    // only" about its own payload. Failing open (`product_changed=true`
    // written directly, no `node` call) is the only safe answer once the base
    // commit's copy could not be read.
    //
    // Split on the `fi` *keyword* closing the `if git show ... ; then`, not on
    // the substring - `split('fi')` alone cuts inside "classifier" on the very
    // first comment line of the else branch, leaving 70 bytes of 1062 to
    // search and passing whether or not a `node` call is hiding past that
    // point (it was, once, while this test still read that way).
    const elseBranch = classifier.slice(classifier.indexOf('else', classifier.indexOf('git show')));
    const body = elseBranch.split(/\n {8}fi\n/)[0];
    assert.ok(body.length > 200, `the else branch looked too short to be real: ${body.length} bytes`);
    assert.doesNotMatch(body, /node /, 'the else branch still runs a classifier - which one, on whose copy?');
    assert.match(body, /product_changed=true/, 'the else branch does not fail open directly');
  });

  it('cannot skip on a classifier that failed rather than answered', () => {
    // Only the checkout and the classify step itself carry `continue-on-error`
    // - a failure in either still lets the job carry on, with
    // `product_changed` unset and the gate's `!= 'false'` running everything
    // downstream. In `checks`, every step after them (Scripts, install,
    // Concepts, and the five gated steps) should NOT continue on error: a real
    // failure in any of those has to fail the job, not disappear the way a
    // classifier hiccup is meant to. The classifier action itself ends in an
    // answer even where the classifier crashed, rather than relying on that.
    const checks = job(workflow('ci.yml'), 'checks');
    const classifierSteps = checks.slice(0, checks.indexOf('- name: Scripts'));
    // Every step in that slice, not a count that a new step could drift past
    // (`- run:` included, not only `- uses:`/`- name:` - a step needs no other
    // key to be one): `- \w+:` at the step indent should equal how many
    // `continue-on-error: true` lines follow it.
    const steps = (classifierSteps.match(/^ {6}- \w+:/gm) ?? []).length;
    const continues = (classifierSteps.match(/^ {8}continue-on-error: true$/gm) ?? []).length;
    assert.ok(steps >= 2, `expected at least two steps ahead of Scripts, found ${steps}`);
    assert.equal(continues, steps, `every step ahead of Scripts should continue on error (${continues} of ${steps} do)`);
    assert.doesNotMatch(checks.slice(checks.indexOf('- name: Scripts')), /continue-on-error: true/, 'a step from Scripts onward should not continue on error');
    assert.match(classifier, /node scripts\/what-changed\.mjs \|\| echo "product_changed=true"/, 'a crashed classifier leaves no answer on a push');
    assert.match(classifier, /node "\$base\/what-changed\.mjs" \|\| echo "product_changed=true"/, "a crashed base commit's classifier leaves no answer");
  });

  it('leave the reports and the writing rules alone', () => {
    // Publish and Stability skip every pull request already, Test Explorer does
    // not gate, and Scripts and Concepts are the checks that read the prose and
    // the registry the gated steps skip on - see their comments in ci.yml.
    const yaml = workflow('ci.yml');
    const checks = job(yaml, 'checks');
    for (const step of ['Scripts', 'Concepts']) {
      assert.ok(!stepNamed(checks, step).includes(stepGate), `${step} should not be gated on what changed`);
    }
    for (const id of ['stability', 'pages']) {
      assert.doesNotMatch(job(yaml, id), /product_changed/, `${id} should not be gated on what changed`);
    }
  });

  it('keep Test Explorer downstream of Test, skipped by what Test says rather than a classifier of its own', () => {
    // Sharing `test`'s instrumented run instead of paying for a second one is
    // "Run the suite once in CI, not once to gate and once to measure" (issue
    // 289), not this file's own finding - `Test Explorer` skips a
    // documentation-only diff on the answer `test` publishes, not a
    // classifier of its own. A rewrite that drops the Concepts step or this chain loses both that
    // saving and the artifact hop `test-explorer-spec.md` documents, silently:
    // every job here still exists and still passes.
    const yaml = workflow('ci.yml');
    // Sorted before comparing: YAML gives `needs:` no order of its own, so
    // asserting the list as written would fail on a harmless reordering for
    // the same reason it should fail on a real one going missing.
    assert.deepEqual(needsOf(job(yaml, 'test-explorer')).sort(), ['test', 'checks'].sort(), "Test Explorer's dependency on Test and Checks went missing");
  });

  it('leave CodeQL ungated by the classifier, which is moot now but shouldn\'t regress', () => {
    // CodeQL no longer runs on a pull request at all ("Decide whether CodeQL
    // earns its run on every pull request push, or moves to main and a
    // schedule", issue 379), so this classifier has nothing to do with it -
    // but the analysis should still wait for nothing and stay unconditional
    // on its push and schedule triggers, the same invariant as before.
    const yaml = workflow('codeql.yml');
    assert.equal(jobIfAny(yaml, 'changes'), null, 'codeql.yml should not classify the diff at all');
    const analyze = job(yaml, 'analyze');
    assert.deepEqual(needsOf(analyze), [], 'the analysis should wait for nothing');
    assert.doesNotMatch(analyze, /product_changed/, 'the analysis should not read the classifier');
  });

  it('keep CodeQL off the pull-request gate, out of branch protection, and on the schedule that replaced it', () => {
    // The test above reads the jobs; nothing read the triggers, so a revert or
    // a bad merge restoring `pull_request:` to this file - or dropping the
    // weekly `schedule:` - passed every check ("Confirm the live
    // branch-protection payload dropped CodeQL's three contexts, and cover
    // codeql.yml's trigger with a test", issue 386). Restoring the trigger is
    // not a harmless regression: CodeQL's three contexts are out of
    // branch-protection.json, so the analysis would report on a pull request
    // that nothing gates, at the cost the move measured. Dropping the schedule
    // is the worse half - main would then be analysed only on merge, and
    // nothing says so.
    const on = triggersOf(workflow('codeql.yml'));
    assert.doesNotMatch(on, /pull_request/, 'CodeQL should not trigger on a pull request');
    assert.match(on, /^ {2}schedule:/m, 'the weekly analysis of main went missing');
    assert.match(on, /^ *- cron: /m, 'the schedule names no cron');
    assert.match(on, /^ {2}push:/m, 'CodeQL should still analyse every merge');
    // The trigger and the payload are one decision, and only half of it lives
    // in this workflow: put CodeQL's contexts back in branch-protection.json
    // without restoring the trigger and every pull request waits on a name
    // nothing reports under, which is what issue 386 was filed to clear.
    const protection = readFileSync(join(repo, '.github/branch-protection.json'), 'utf8');
    assert.doesNotMatch(protection, /CodeQL/, 'branch protection requires a context CodeQL no longer reports');
  });
});
