#!/usr/bin/env node
//
// The E2E (F3) job's own step (.github/workflows/ci.yml): places the diff
// (scripts/lib/merge-base.mjs), decides with planE2eRun
// (scripts/lib/e2e-selection.mjs) whether to run every walk or only the areas
// the diff touches, and runs Playwright with the matching `--grep`. The
// decision is tested there without a browser; this is orchestration only, the
// split scripts/ci-test.mjs uses.
//
// Reproducing a selection by hand: `GITHUB_EVENT_NAME=pull_request` on a
// checkout of a pull request's merge commit.
//

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { walksIn } from './lib/e2e-ceilings.mjs';
import { planE2eRun } from './lib/e2e-selection.mjs';
import { placeMergeBase } from './lib/merge-base.mjs';
import { paint, pnpmWorkspaceList } from './lib/processes.mjs';
import { testablePackages } from './lib/workspace.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const shell = process.platform === 'win32';

/** Trimmed stdout from `file args...`, run in `root`. Throws on a non-zero exit. */
function capture(file, args) {
  return execFileSync(file, args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, shell, stdio: ['ignore', 'pipe', 'inherit'] }).trim();
}

/** Runs Playwright with `args`, output inherited; returns its exit code. */
function playwright(args) {
  const quoted = shell ? args.map((arg) => (/[\s|()]/.test(arg) ? `"${arg}"` : arg)) : args;
  return spawnSync('pnpm', ['exec', 'playwright', 'test', ...quoted], { cwd: root, stdio: 'inherit', shell }).status ?? 1;
}

const event = process.env.GITHUB_EVENT_NAME ?? '';
const { mergeBase, changedFiles } = placeMergeBase(event, (args) => capture('git', args), (message) => console.error(paint('33', message)));

let plan;
try {
  const packages = testablePackages(pnpmWorkspaceList(root), (pkgPath) => JSON.parse(readFileSync(join(pkgPath, 'package.json'), 'utf8')), root);
  const { concepts } = JSON.parse(readFileSync(join(root, 'tools/test-explorer/concepts.json'), 'utf8'));
  // `--list` starts no stack and needs no browser (scripts/e2e-ceilings.mjs).
  const walks = walksIn(JSON.parse(capture('pnpm', ['exec', 'playwright', 'test', '--list', '--reporter=json'])));
  plan = planE2eRun({ event, mergeBase, changedFiles, concepts, walks, packages });
} catch (error) {
  // A selection that cannot be made is never a reason to run less.
  console.error(paint('33', `Could not plan a selection (${error.message}); running every walk.`));
  plan = { mode: 'full', reason: 'the selection failed' };
}

if (plan.mode === 'full') {
  console.log(paint('2', `Running every browser walk (${plan.reason}).`));
  process.exit(playwright([]));
}

if (!plan.grep) {
  console.log(paint('2', `The diff touches no area that owns a browser walk (${plan.areas.join(', ') || 'none'}); nothing to run.`));
  process.exit(0);
}

console.log(paint('2', `Running the browser walks of ${plan.areas.join(', ')}.`));
process.exit(playwright(['--grep', plan.grep]));
