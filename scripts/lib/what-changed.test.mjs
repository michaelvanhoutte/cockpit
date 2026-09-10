//
// Two halves, and both are needed. The first proves the classifier tells a
// documentation-only diff from every other kind, against path lists written
// here. The second reads the two workflow files, which is the half that gates:
// the classifier is only worth anything if the jobs actually consult it, and a
// job added or an output renamed would otherwise be found by a pull request
// that skipped its own checks.
//

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { diffRange, isNonProduct, pathsFromDiff, productChanged, productPaths } from './what-changed.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '../..');
const workflow = (name) => readFileSync(join(repo, '.github/workflows', name), 'utf8');

/** A commit the way GitHub writes one. */
const sha = (char) => char.repeat(40);

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

  it('runs them on a path that only looks like documentation', () => {
    // Prefixes are exact and case-sensitive, and Markdown is only prose when it
    // sits at the root: everything else falls through to the product, which is
    // the direction that costs a run rather than a merge.
    for (const path of ['docsite/index.html', '.claude-plugin/marketplace.json', 'Docs/architecture.md', 'tools/test-explorer/readme.md']) {
      assert.equal(productChanged([path]), true, `${path} should force the full suite`);
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
    assert.deepEqual(pathsFromDiff('docs/a b.md\0apps/web/src/main.tsx\0'), ['docs/a b.md', 'apps/web/src/main.tsx']);
    assert.deepEqual(pathsFromDiff(''), []);
    assert.deepEqual(pathsFromDiff(undefined), []);
  });
});

describe('the mechanical jobs', () => {
  const gate = "if: ${{ !cancelled() && needs.changes.outputs.product_changed != 'false' }}";

  /** One job's own lines, from its key down to whatever comes next at that indent. */
  function job(yaml, id) {
    const lines = yaml.split('\n');
    const start = lines.indexOf(`  ${id}:`);
    assert.notEqual(start, -1, `${id} is not a job here`);
    const rest = lines.slice(start + 1);
    const end = rest.findIndex((line) => /^ {2}\S/.test(line));
    return rest.slice(0, end === -1 ? rest.length : end).join('\n');
  }

  it('consult what changed, in both workflow files, since needs cannot cross one', () => {
    for (const [file, ids] of [
      ['ci.yml', ['typecheck', 'lint', 'test', 'e2e', 'build']],
      ['codeql.yml', ['analyze']],
    ]) {
      const yaml = workflow(file);
      assert.match(job(yaml, 'changes'), /product_changed: \$\{\{ steps\.classify\.outputs\.product_changed \}\}/, `${file}'s changes job publishes no answer`);
      assert.match(job(yaml, 'changes'), /node scripts\/what-changed\.mjs/, `${file}'s changes job decides it somewhere else`);
      for (const id of ids) {
        const block = job(yaml, id);
        assert.match(block, /needs: changes/, `${file}'s ${id} job does not wait for what changed`);
        assert.ok(block.includes(gate), `${file}'s ${id} job does not carry the gate: ${gate}`);
      }
    }
  });

  it('leave the reports and the writing rules alone', () => {
    // Publish and Stability skip every pull request already, Test Explorer does
    // not gate, and Scripts is the check that reads the prose the others skip
    // on - see its comment in ci.yml.
    const yaml = workflow('ci.yml');
    for (const id of ['scripts', 'test-explorer', 'stability', 'pages']) {
      assert.doesNotMatch(job(yaml, id), /needs: changes/, `${id} should not be gated on what changed`);
    }
  });
});
