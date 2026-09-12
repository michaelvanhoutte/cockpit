//
// Two halves, and both are needed. The first proves the classifier tells a
// documentation-only diff from every other kind, against path lists written
// here, and that every way its I/O can fail still says "product changed". The
// second reads the two workflow files, which is the half that gates: the
// classifier is only worth anything if the jobs actually consult it, and a job
// added or an output renamed would otherwise be found by a pull request that
// skipped its own checks.
//

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { changeClass, classify, diffRange, isNonProduct, localChangeAnswer, pathsFromDiff, printable, productChanged, productPaths } from './what-changed.mjs';

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
  // reason backup.test.mjs and health.test.mjs give beside their own.
  for (const { situation, paths, want } of [
    {
      situation: 'uncommitted and committed changes on a branch, all under docs/',
      paths: ['docs/architecture.md', 'docs/deployment.md'],
      want: { class: 'docs' },
    },
    {
      situation: 'the same with one file under apps/web/src',
      paths: ['docs/architecture.md', 'apps/web/src/main.tsx'],
      want: { class: 'product' },
    },
    {
      situation: "only deleted or changed files under a package's tests/",
      paths: ['apps/api/tests/unit/commands.test.ts', 'apps/api/tests/integration/http/item-changes.test.ts'],
      want: { class: 'tests', packages: ['@cockpit/api'] },
    },
  ]) {
    it(`answers ${situation}`, () => {
      assert.deepEqual(changeClass({ paths, packages }), want);
    });
  }
});

describe('localChangeAnswer', () => {
  const packages = [
    { name: '@cockpit/api', dir: 'apps/api' },
    { name: '@cockpit/web', dir: 'apps/web' },
  ];

  /** A `packages` thunk that fails the test if scripts/local-changes.mjs's own short-circuit ever calls it. */
  const mustNotBeCalled = () => assert.fail('localChangeAnswer asked for the workspace on a diff that never needed it');

  it("never asks for the workspace on a documentation-only diff - the pnpm -r list a docs-only push has no reason to pay for", () => {
    const paths = ['docs/architecture.md', 'docs/deployment.md'];
    assert.equal(localChangeAnswer(paths, mustNotBeCalled), 'documentation only');
  });

  it('names the package a test-only diff belongs to', () => {
    const paths = ['apps/api/tests/unit/commands.test.ts'];
    assert.equal(localChangeAnswer(paths, () => packages), 'tests only (@cockpit/api)');
  });

  it('answers product changed on a mix of docs and product paths, without needing to ask why', () => {
    const paths = ['docs/architecture.md', 'apps/web/src/main.tsx'];
    assert.equal(localChangeAnswer(paths, () => packages), 'product changed');
  });

  it('answers product changed on an empty diff, agreeing with changeClass rather than reading it as documentation', () => {
    // paths.length is 0, not > 0 - the one case the docs-only short-circuit
    // deliberately excludes (scripts/local-changes.mjs's own comment on it),
    // so this still asks for the workspace.
    let asked = false;
    assert.equal(
      localChangeAnswer([], () => {
        asked = true;
        return packages;
      }),
      'product changed',
    );
    assert.equal(asked, true, 'an empty diff should still consult changeClass, not shortcut past it');
  });

  it('answers product changed, the safe direction, where the workspace could not be read', () => {
    const paths = ['apps/web/src/main.tsx'];
    assert.equal(
      localChangeAnswer(paths, () => {
        throw new Error('pnpm -r list failed: exit 1');
      }),
      'product changed',
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
    // one sitting right after it - the same hazard review-gate.mjs's `oneLine`
    // breaks up, which this mirrors.
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

  it('says a documentation-only pull request changed nothing the checks read', () => {
    const { changed, lines } = classify(readers({ event: pullRequest, diff: `docs/a.md${NUL}CLAUDE.md${NUL}` }));
    assert.equal(changed, false);
    assert.match(lines[0], /2 path\(s\) changed, 0 of them product\./);
  });

  it('names the product paths that made the suite run, and stops naming at twenty', () => {
    const many = Array.from({ length: 25 }, (unused, index) => `apps/web/src/f${index}.ts`);
    const { changed, lines } = classify(readers({ event: pullRequest, diff: `${many.join(NUL)}${NUL}` }));
    assert.equal(changed, true);
    assert.equal(lines.filter((line) => line.startsWith('  apps/')).length, 20);
    assert.equal(lines.at(-1), '  ... and 5 more');
  });

  it('says why it ran everything on a range with nothing in it, rather than "0 of them product"', () => {
    // productChanged([]) is true, not false - a range git resolved to no
    // files is not the same claim as "found only documentation", and the log
    // line has to say which one happened.
    const { changed, lines } = classify(readers({ event: pullRequest, diff: '' }));
    assert.equal(changed, true);
    assert.equal(lines.length, 1);
    assert.doesNotMatch(lines[0], /0 of them product/);
    assert.match(lines[0], /no paths in this diff/);
  });

  it('runs everything when git could not answer, and says so as a warning', () => {
    const { changed, lines } = classify(readers({ event: pullRequest, failDiff: true }));
    assert.equal(changed, true);
    assert.match(lines[0], /^::warning::Could not diff /);
    assert.equal(lines.length, 1);
  });

  it('runs everything when there is no event payload to read', () => {
    const { changed, lines } = classify(readers({ failRead: true }));
    assert.equal(changed, true);
    assert.match(lines[0], /^No diff range for a pull_request event/);
  });

  it('runs everything when the event payload is not the JSON it should be', () => {
    for (const event of ['', 'not json at all', '[]']) {
      const { changed } = classify(readers({ event }));
      assert.equal(changed, true, `a payload of ${JSON.stringify(event)} should run everything`);
    }
  });

  it('runs everything on an event it has no range for', () => {
    const { changed, lines } = classify({ ...readers({ event: pullRequest }), eventName: 'schedule' });
    assert.equal(changed, true);
    assert.match(lines[0], /^No diff range for a schedule event/);
    assert.equal(classify().changed, true);
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
  const jobGate = "if: ${{ !cancelled() && needs.checks.outputs.product_changed != 'false' }}";
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

  it('consult what changed, since a skipped step or job is what a required check accepts', () => {
    const yaml = workflow('ci.yml');
    const checks = job(yaml, 'checks');
    assert.match(checks, /product_changed: \$\{\{ steps\.classify\.outputs\.product_changed \}\}/, "ci.yml's checks job publishes no answer");
    assert.match(checks, /node scripts\/what-changed\.mjs/, "ci.yml's checks job does not run the classifier on a push");
    assert.match(checks, /node "\$base\/what-changed\.mjs"/, "ci.yml's checks job does not run the base commit's own copy");
    for (const id of ['test', 'e2e']) {
      const block = job(yaml, id);
      assert.ok(needsOf(block).includes('checks'), `ci.yml's ${id} job does not wait for what changed`);
      assert.ok(block.includes(jobGate), `ci.yml's ${id} job does not carry the gate: ${jobGate}`);
    }
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

  it('decide from the base commit, so a branch cannot rule on its own diff', () => {
    // `pull_request` builds the merge ref, so the classifier in the tree is the
    // one this branch wrote. Running it would let a diff answer "documentation
    // only" about its own payload and skip every check that would have read it.
    const checks = job(workflow('ci.yml'), 'checks');
    assert.match(checks, /BASE_SHA: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/, 'the base commit is never named');
    assert.match(checks, /git show "\$BASE_SHA:scripts\/what-changed\.mjs"/, "the base commit's own wrapper is not taken");
    assert.match(checks, /git show "\$BASE_SHA:scripts\/lib\/what-changed\.mjs"/, "the base commit's own module is not taken");
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
    const checks = job(workflow('ci.yml'), 'checks');
    const elseBranch = checks.slice(checks.indexOf('else', checks.indexOf('git show')));
    const body = elseBranch.split(/\n {10}fi\n/)[0];
    assert.ok(body.length > 200, `the else branch looked too short to be real: ${body.length} bytes`);
    assert.doesNotMatch(body, /node /, "the else branch still runs a classifier - which one, on whose copy?");
    assert.match(body, /product_changed=true/, 'the else branch does not fail open directly');
  });

  it('cannot skip on a classifier that failed rather than answered', () => {
    // Only the checkout and the classify step itself carry `continue-on-error`
    // - a failure in either still lets the job carry on to Scripts next, with
    // `product_changed` unset and the gate's `!= 'false'` running everything
    // downstream. Every step after them (Scripts, install, Concepts, and the
    // five gated steps) should NOT continue on error: a real failure in any of
    // those has to fail the job, not disappear the way a classifier hiccup is
    // meant to.
    const yaml = workflow('ci.yml');
    const checks = job(yaml, 'checks');
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
    // `needs` on a failed job skips the lot, and a skip is what a required check
    // accepts - so `test` and `e2e` still read `!cancelled()`, the same reason
    // `pages` further down this file does: GitHub's own expressions reference
    // names it the way to run a job regardless of an upstream failure, and
    // unlike `!failure()` - true on exactly the condition the default
    // `success()` already tests for a `needs`-only job, so it would have
    // changed nothing - it does not also turn a genuinely cancelled run into a
    // passing `skipped` the way `!cancelled()` mistakenly not being used once
    // did (docs/deployment.md, "Bootstrap runbook": "A cancelled run reports
    // `cancelled`, not a passing conclusion").
    assert.match(job(yaml, 'test'), /!cancelled\(\)/, 'the gate should run despite checks failing outright, not only despite its output being unset');
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
    for (const id of ['test-explorer', 'stability', 'pages']) {
      assert.doesNotMatch(job(yaml, id), /needs\.checks\.outputs\.product_changed/, `${id} should not be gated on what changed`);
    }
  });

  it('keep Test Explorer downstream of Test, not gated on what changed', () => {
    // Sharing `test`'s instrumented run instead of paying for a second one is
    // "Run the suite once in CI, not once to gate and once to measure" (issue
    // 289), not this file's own finding - `Test Explorer` skips a
    // documentation-only diff for free, because `test` does and a skipped
    // dependency is not a successful one, rather than needing a gate of its
    // own. A rewrite that drops the Concepts step or this chain loses both that
    // saving and the artifact hop `test-explorer-spec.md` documents, silently:
    // every job here still exists and still passes.
    const yaml = workflow('ci.yml');
    // Sorted before comparing: YAML gives `needs:` no order of its own, so
    // asserting the list as written would fail on a harmless reordering for
    // the same reason it should fail on a real one going missing.
    assert.deepEqual(needsOf(job(yaml, 'test-explorer')).sort(), ['test', 'checks'].sort(), "Test Explorer's dependency on Test and Checks went missing");
  });

  it('leave CodeQL to run on every diff, its third context being nobody here to post', () => {
    // `CodeQL (javascript-typescript)` and `CodeQL (actions)` are jobs and would
    // skip safely. The third required context, `CodeQL`, is posted by GitHub
    // Advanced Security when an analysis uploads results, and a required context
    // nothing reports under waits forever - see the note at the top of codeql.yml.
    const yaml = workflow('codeql.yml');
    assert.equal(jobIfAny(yaml, 'changes'), null, 'codeql.yml should not classify the diff at all');
    const analyze = job(yaml, 'analyze');
    assert.deepEqual(needsOf(analyze), [], 'the analysis should wait for nothing');
    assert.doesNotMatch(analyze, /product_changed/, 'the analysis should not read the classifier');
  });
});

describe("the code review's own classifier", () => {
  // claude-code-review.yml's version of ci.yml's `checks` job - see its
  // comment there for why this is a second copy rather than a shared one.
  // Unlike `checks`, this workflow never consolidated several small jobs
  // into one, so it stays a producer job (`changes`) and a consumer
  // (`claude-review`) rather than gated steps of a single job. `job`,
  // `jobIfAny` and `needsOf` are shared module-scope helpers, above.
  const changes = () => job(workflow('claude-code-review.yml'), 'changes');
  const claudeReview = () => job(workflow('claude-code-review.yml'), 'claude-review');

  it('publishes the same product_changed output, read from the base commit', () => {
    const block = changes();
    assert.match(block, /product_changed: \$\{\{ steps\.classify\.outputs\.product_changed \}\}/, 'the changes job publishes no answer');
    assert.match(block, /BASE_SHA: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/, 'the base commit is never named');
    assert.match(block, /git show "\$BASE_SHA:scripts\/what-changed\.mjs"/, "the base commit's own wrapper is not taken");
    assert.match(block, /git show "\$BASE_SHA:scripts\/lib\/what-changed\.mjs"/, "the base commit's own module is not taken");
    assert.doesNotMatch(block, /node scripts\/what-changed\.mjs/, 'this workflow never triggers on push, so it should not carry a push fallback');
  });

  it('cannot skip on a classifier that failed rather than answered', () => {
    // Mirrors ci.yml's own version of this test: both steps continue past a
    // failure, and the else branch fails open (`product_changed=true`
    // written directly) rather than falling back to this branch's own copy.
    const block = changes();
    const steps = (block.match(/^ {6}- \w+:/gm) ?? []).length;
    const continues = (block.match(/^ {8}continue-on-error: true$/gm) ?? []).length;
    assert.ok(steps >= 2, `expected at least two steps in the changes job, found ${steps}`);
    assert.equal(continues, steps, `every step of the changes job should continue on error (${continues} of ${steps} do)`);
    const elseBranch = block.slice(block.indexOf('else', block.indexOf('git show')));
    assert.doesNotMatch(elseBranch, /node /, 'the else branch still runs a classifier - which one, on whose copy?');
    assert.match(elseBranch, /product_changed=true/, 'the else branch does not fail open directly');
  });

  it('skips itself on a fork, a draft or a bot pull request, the same way claude-review does', () => {
    // Those three already cost this workflow zero runner minutes before this
    // classifier existed - claude-review's own job-level `if:` was enough on
    // its own to never start one. Without the same guard here, every one of
    // those pull requests would pay for a checkout computing an answer
    // claude-review would ignore regardless, reintroducing exactly the cost
    // the guard exists to avoid.
    const block = changes();
    for (const clause of [
      'github.event.pull_request.head.repo.full_name == github.repository',
      'github.event.pull_request.draft == false',
      "github.event.pull_request.user.type != 'Bot'",
    ]) {
      assert.ok(block.includes(clause), `the changes job is missing the guard: ${clause}`);
    }
  });

  it('gates claude-review on what changed, the same way ci.yml gates its own mechanical jobs', () => {
    const block = claudeReview();
    assert.ok(needsOf(block).includes('changes'), 'the claude-review job does not wait for what changed');
    assert.match(block, /!cancelled\(\)/, 'the gate should run despite changes failing outright, not only despite its output being unset');
    assert.match(block, /needs\.changes\.outputs\.product_changed != 'false'/, 'the claude-review job does not read the classifier');
  });

  it('skips the whole job, assert step included, so the gate can never read the skip as a decline', () => {
    // "Assert the review actually ran" is a step of claude-review itself, not
    // a job of its own - so the same `if:` that skips a fork, a draft or a
    // bot pull request skips this step with it, and a documentation-only one
    // is skipped the identical way. There is no path here where the review
    // step is skipped but the assert step still runs against an empty
    // execution file, which is what would read a legitimate skip as a
    // reviewer that looked and said nothing.
    const block = claudeReview();
    assert.match(block, /Assert the review actually ran/, 'the assert step should live inside the claude-review job');
    assert.equal(jobIfAny(workflow('claude-code-review.yml'), 'assert-code-review'), null, 'the assert step should not be split into a job of its own');
  });
});
