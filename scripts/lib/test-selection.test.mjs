//
// Unit tests for planTestRun, run by `node --test` from the Scripts step -
// the same place review-gate.test.mjs and the rest of scripts/lib are
// asserted. Each case here is a row of the statement list from "Run only the
// affected tests in CI's Test job on a pull request" (issue 346) or "Stop a
// documentation edit forcing every package's tests to run in full" (issue
// 370); the ones issue 346's table marks "verified by hand" (the checkout
// step's fetch depth, and Vitest's own dependency-graph walk) have no
// equivalent here on purpose - there is nothing pure to assert about either.
//

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { planTestRun } from './test-selection.mjs';
import { isNonProduct } from './what-changed.mjs';

const MERGE_BASE = 'a1b2c3d';

/** A representative package list - the logic under test is generic over any dir, so three stands in for the real five. */
const PACKAGES = [
  { name: '@cockpit/shared', dir: 'packages/shared' },
  { name: '@cockpit/api', dir: 'apps/api' },
  { name: '@cockpit/web', dir: 'apps/web' },
];

/** A pull_request plan for the given changed paths, against a fixed merge-base. */
function forPR(changedFiles) {
  return planTestRun({ event: 'pull_request', mergeBase: MERGE_BASE, changedFiles, packages: PACKAGES });
}

function modeOf(plan, dir) {
  return plan.packages.find((pkg) => pkg.dir === dir).mode;
}

function allModes(plan) {
  return Object.fromEntries(plan.packages.map((pkg) => [pkg.dir, pkg.mode]));
}

describe('planTestRun', () => {
  it('requires the package list rather than guessing at one', () => {
    assert.throws(() => planTestRun({ event: 'pull_request', mergeBase: MERGE_BASE, changedFiles: [] }), /needs the workspace package list/);
  });

  it('runs every package selectively for a leaf file with its own test', () => {
    const plan = forPR(['apps/web/src/components/InboxColumn.tsx']);
    for (const pkg of PACKAGES) assert.equal(modeOf(plan, pkg.dir), 'changed', pkg.dir);
  });

  it('runs every package selectively for a change to packages/shared, leaving the import walk to Vitest', () => {
    // Which *tests* that pulls in across apps/api and apps/web is Vitest's own
    // `--changed` to decide (the issue's "Cut" note) - this only has to not
    // treat the shared package itself as a reason for anyone to run in full.
    const plan = forPR(['packages/shared/src/commands.ts']);
    for (const pkg of PACKAGES) assert.equal(modeOf(plan, pkg.dir), 'changed', pkg.dir);
  });

  it('runs every package selectively when only a test file changed', () => {
    const plan = forPR(['apps/api/tests/unit/accounts/repo.test.ts']);
    for (const pkg of PACKAGES) assert.equal(modeOf(plan, pkg.dir), 'changed', pkg.dir);
  });

  it('runs every package in full for anything but a pull request, whatever changed', () => {
    for (const event of ['push', 'workflow_dispatch', undefined]) {
      const plan = planTestRun({ event, mergeBase: MERGE_BASE, changedFiles: ['apps/web/src/App.tsx'], packages: PACKAGES });
      for (const pkg of PACKAGES) assert.equal(modeOf(plan, pkg.dir), 'full', `${event} / ${pkg.dir}`);
    }
  });

  it('forces only apps/api into full for a migration, leaving the others selective', () => {
    const plan = forPR(['apps/api/migrations/0007_add_note_state.sql']);
    assert.deepEqual(allModes(plan), { 'packages/shared': 'changed', 'apps/api': 'full', 'apps/web': 'changed' });
  });

  it('forces only apps/web into full for its own package.json, leaving the others selective', () => {
    const plan = forPR(['apps/web/package.json']);
    assert.deepEqual(allModes(plan), { 'packages/shared': 'changed', 'apps/api': 'changed', 'apps/web': 'full' });
  });

  it('forces every package into full for the root package.json', () => {
    const plan = forPR(['package.json']);
    for (const pkg of PACKAGES) assert.equal(modeOf(plan, pkg.dir), 'full', pkg.dir);
  });

  it('forces every package into full for the lockfile', () => {
    const plan = forPR(['pnpm-lock.yaml']);
    for (const pkg of PACKAGES) assert.equal(modeOf(plan, pkg.dir), 'full', pkg.dir);
  });

  it('forces every package into full for any tsconfig*.json, root or nested inside one package, dot-separated suffix or not', () => {
    for (const path of ['tsconfig.json', 'apps/api/tsconfig.json', 'tsconfig.base.json', 'tsconfig-build.json']) {
      const plan = forPR([path]);
      for (const pkg of PACKAGES) assert.equal(modeOf(plan, pkg.dir), 'full', `${path} / ${pkg.dir}`);
    }
  });

  it('forces only the one package whose vitest.config.ts changed', () => {
    const plan = forPR(['apps/web/vitest.config.ts']);
    assert.deepEqual(allModes(plan), { 'packages/shared': 'changed', 'apps/api': 'changed', 'apps/web': 'full' });
  });

  it('forces only apps/api into full for its own wrangler.jsonc, the binding config its vitest.config.ts runs the suite against', () => {
    const plan = forPR(['apps/api/wrangler.jsonc']);
    assert.deepEqual(allModes(plan), { 'packages/shared': 'changed', 'apps/api': 'full', 'apps/web': 'changed' });
  });

  it('forces only apps/api into full for a global-setup.ts anywhere under it, wherever its own vitest.config.ts names one', () => {
    const plan = forPR(['apps/api/tests/integration/global-setup.ts']);
    assert.deepEqual(allModes(plan), { 'packages/shared': 'changed', 'apps/api': 'full', 'apps/web': 'changed' });
  });

  it('forces every package into full for a workflow file, or any other file under .github/', () => {
    for (const path of ['.github/workflows/ci.yml', '.github/actions/setup/action.yml', '.github/dependabot.yml']) {
      const plan = forPR([path]);
      for (const pkg of PACKAGES) assert.equal(modeOf(plan, pkg.dir), 'full', `${path} / ${pkg.dir}`);
    }
  });

  it('forces every package into full for a root-level file nothing here was written to expect', () => {
    // The point of deriving the boundary from `packages` instead of a list of
    // paths: a kind of root config nobody enumerated (here, a hypothetical
    // .nvmrc or eslint.config.js) is still outside every package's own
    // directory, so it is covered without a code change.
    for (const path of ['.nvmrc', 'eslint.config.js', 'turbo.json']) {
      const plan = forPR([path]);
      for (const pkg of PACKAGES) assert.equal(modeOf(plan, pkg.dir), 'full', `${path} / ${pkg.dir}`);
    }
  });

  it('forces every package into full when the merge-base could not be computed', () => {
    const plan = planTestRun({ event: 'pull_request', mergeBase: null, changedFiles: ['apps/web/src/App.tsx'], packages: PACKAGES });
    for (const pkg of PACKAGES) assert.equal(modeOf(plan, pkg.dir), 'full', pkg.dir);
  });

  it('does not mistake a package-adjacent file for the trigger it resembles', () => {
    // apps/api/migrations-notes.md is not under migrations/, and
    // apps/web/src/vitest.config.ts is not that package's own config.
    const plan = forPR(['apps/api/migrations-notes.md', 'apps/web/src/vitest.config.ts']);
    for (const pkg of PACKAGES) assert.equal(modeOf(plan, pkg.dir), 'changed', pkg.dir);
  });

  it('runs every package selectively for a source change alongside a docs change, not full for the docs change alone', () => {
    // Before this only counted product paths against every package's own
    // directory, a docs/ path here - outside every package - forced every
    // package into full for a diff only apps/api had anything to do with.
    const plan = forPR(['apps/api/src/index.ts', 'docs/architecture.md']);
    for (const pkg of PACKAGES) assert.equal(modeOf(plan, pkg.dir), 'changed', pkg.dir);
  });

  it('runs every package selectively for a documentation-only pull request, which leaves nothing for any of them to run', () => {
    const plan = forPR(['CLAUDE.md', 'docs/deployment.md', '.claude/skills/testing/SKILL.md']);
    for (const pkg of PACKAGES) assert.equal(modeOf(plan, pkg.dir), 'changed', pkg.dir);
  });

  it('still forces every package into full for a docs change alongside the lockfile', () => {
    const plan = forPR(['docs/architecture.md', 'pnpm-lock.yaml']);
    for (const pkg of PACKAGES) assert.equal(modeOf(plan, pkg.dir), 'full', pkg.dir);
  });

  it('still forces every package into full for a docs change alongside a root tsconfig', () => {
    const plan = forPR(['docs/architecture.md', 'tsconfig.json']);
    for (const pkg of PACKAGES) assert.equal(modeOf(plan, pkg.dir), 'full', pkg.dir);
  });

  it('shares its non-product path list with the what-changed classifier, so the two cannot drift apart', () => {
    // Asserted against the source rather than by behaviour alone: importing
    // isNonProduct here and calling it inline would pass even if
    // test-selection.mjs itself carried its own separate copy of the same
    // rule, exactly the drift issue 370 exists to rule out.
    const path = fileURLToPath(new URL('./test-selection.mjs', import.meta.url));
    const source = readFileSync(path, 'utf8');
    assert.match(source, /import\s*\{\s*isNonProduct\s*\}\s*from\s*'\.\/what-changed\.mjs';/, 'test-selection.mjs should import isNonProduct rather than duplicate it');
    assert.equal(typeof isNonProduct, 'function');
  });
});
