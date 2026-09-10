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

import { classify, diffRange, isNonProduct, pathsFromDiff, printable, productChanged, productPaths } from './what-changed.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '../..');
const workflow = (name) => readFileSync(join(repo, '.github/workflows', name), 'utf8');

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
      const empty = paths.filter((path) => path.trim() !== '').length === 0;
      assert.equal(productChanged(paths), empty || productPaths(paths).length > 0, `${JSON.stringify(paths)} is answered two ways`);
    }
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

describe('the mechanical jobs', () => {
  const gate = "if: ${{ needs.changes.outputs.product_changed != 'false' }}";

  /** One job's own lines, from its key down to whatever comes next at that indent. */
  function job(yaml, id) {
    const block = jobIfAny(yaml, id);
    assert.notEqual(block, null, `${id} is not a job here`);
    return block;
  }

  /** The same, but `null` rather than a failure where there is no such job. */
  function jobIfAny(yaml, id) {
    const lines = yaml.split('\n');
    const start = lines.indexOf(`  ${id}:`);
    if (start === -1) return null;
    const rest = lines.slice(start + 1);
    const end = rest.findIndex((line) => /^ {2}\S/.test(line));
    return rest.slice(0, end === -1 ? rest.length : end).join('\n');
  }

  /**
   * The jobs a block declares it waits for, in any of the three shapes YAML
   * allows. Matching `/needs: changes/` alone would read `needs: [changes, x]`
   * as no dependency at all, so a job could gain the gate - or lose it - without
   * either assertion below noticing.
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

  it('reads a dependency in every shape a workflow file may write one', () => {
    assert.deepEqual(needsOf('    needs: changes\n    runs-on: x'), ['changes']);
    assert.deepEqual(needsOf('    needs: [test-explorer, changes]\n    runs-on: x'), ['test-explorer', 'changes']);
    assert.deepEqual(needsOf('    needs:\n      - test-explorer\n      - changes\n    runs-on: x'), ['test-explorer', 'changes']);
    assert.deepEqual(needsOf('    runs-on: x'), []);
  });

  it('consult what changed, since a skipped job is what a required check accepts', () => {
    const yaml = workflow('ci.yml');
    const changes = job(yaml, 'changes');
    assert.match(changes, /product_changed: \$\{\{ steps\.classify\.outputs\.product_changed \}\}/, "ci.yml's changes job publishes no answer");
    assert.match(changes, /node scripts\/what-changed\.mjs/, "ci.yml's changes job does not run the classifier on a push");
    assert.match(changes, /node "\$base\/what-changed\.mjs"/, "ci.yml's changes job does not run the base commit's own copy");
    for (const id of ['typecheck', 'lint', 'test', 'e2e', 'build']) {
      const block = job(yaml, id);
      assert.ok(needsOf(block).includes('changes'), `ci.yml's ${id} job does not wait for what changed`);
      assert.ok(block.includes(gate), `ci.yml's ${id} job does not carry the gate: ${gate}`);
    }
  });

  it('decide from the base commit, so a branch cannot rule on its own diff', () => {
    // `pull_request` builds the merge ref, so the classifier in the tree is the
    // one this branch wrote. Running it would let a diff answer "documentation
    // only" about its own payload and skip every check that would have read it.
    const changes = job(workflow('ci.yml'), 'changes');
    assert.match(changes, /BASE_SHA: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/, 'the base commit is never named');
    assert.match(changes, /git show "\$BASE_SHA:scripts\/what-changed\.mjs"/, "the base commit's own wrapper is not taken");
    assert.match(changes, /git show "\$BASE_SHA:scripts\/lib\/what-changed\.mjs"/, "the base commit's own module is not taken");
  });

  it('never falls back to the pull request\'s own classifier when the base commit has none', () => {
    // A pull request whose base predates this classifier - every branch open
    // when it merges, until each is rebased - would otherwise hit exactly the
    // fallback the base-commit extraction exists to prevent: running the
    // branch's own copy, which a tampered one could answer "documentation
    // only" about its own payload. Failing open (`product_changed=true`
    // written directly, no `node` call) is the only safe answer once the base
    // commit's copy could not be read.
    const changes = job(workflow('ci.yml'), 'changes');
    const elseBranch = changes.slice(changes.indexOf('else', changes.indexOf('git show')));
    assert.doesNotMatch(elseBranch.split('fi')[0], /node /, "the else branch still runs a classifier - which one, on whose copy?");
    assert.match(elseBranch, /product_changed=true/, 'the else branch does not fail open directly');
  });

  it('cannot skip on a classifier that failed rather than answered', () => {
    // `needs` on a failed job skips the lot, and a skip is what a required check
    // accepts - so this job carries `continue-on-error` instead of the gate
    // carrying `!cancelled()`, which would have turned a cancelled run into a
    // passing one.
    const yaml = workflow('ci.yml');
    const changes = job(yaml, 'changes');
    assert.equal((changes.match(/^ {8}continue-on-error: true$/gm) ?? []).length, 2, 'both steps of the changes job should continue on error');
    assert.doesNotMatch(job(yaml, 'typecheck'), /!cancelled\(\)/, 'the gate should leave a cancelled run cancelled');
  });

  it('leave the reports and the writing rules alone', () => {
    // Publish and Stability skip every pull request already, Test Explorer does
    // not gate, and Scripts is the check that reads the prose the others skip
    // on - see its comment in ci.yml.
    const yaml = workflow('ci.yml');
    for (const id of ['scripts', 'test-explorer-check', 'test-explorer', 'stability', 'pages']) {
      assert.ok(!needsOf(job(yaml, id)).includes('changes'), `${id} should not be gated on what changed`);
    }
  });

  it('keep Test Explorer downstream of Test, not of this job', () => {
    // Sharing `test`'s instrumented run instead of paying for a second one is
    // issue 289's finding, not this issue's - `Test Explorer` skips a
    // documentation-only diff for free, because `test` does and a skipped
    // dependency is not a successful one, rather than needing a gate of its
    // own. A rewrite that drops `Concepts` or this chain loses both that
    // saving and the artifact hop `test-explorer-spec.md` documents, silently:
    // every job here still exists and still passes.
    const yaml = workflow('ci.yml');
    // Sorted before comparing: YAML gives `needs:` no order of its own, so
    // asserting the list as written would fail on a harmless reordering for
    // the same reason it should fail on a real one going missing.
    assert.deepEqual(needsOf(job(yaml, 'test-explorer')).sort(), ['test', 'test-explorer-check'].sort(), "Test Explorer's dependency on Test and Concepts went missing");
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
