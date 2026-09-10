#!/usr/bin/env node
//
// The Test job's own step (.github/workflows/ci.yml): works out which
// packages exist and what changed, decides what each one runs with
// testablePackages (scripts/lib/workspace.mjs) and planTestRun
// (scripts/lib/test-selection.mjs), and runs it. Both decisions are tested
// there without a checkout or a real workspace; this is orchestration only,
// the same split bundle-budget.mjs and dev.mjs use.
//
// What stands in for the merge-base with `main` is read off HEAD itself
// rather than fetched or computed with `git merge-base`: the default checkout
// for a pull_request event is GitHub's own merge of the PR against its base
// (refs/pull/<n>/merge), kept current with `main` as `main` moves, so HEAD's
// first parent is the base commit that merge was actually computed against -
// no origin/main ref required, only enough history for that parent commit to
// be present, which is what the Test job's checkout step asks for with
// fetch-depth: 0. A textbook `git merge-base` would instead return the PR
// branch's own fork point, which is only the same commit when the PR is
// already caught up with `main` - using the fork point here would inflate
// "changed" by everything `main` has gained since the PR forked, working
// against the point of selecting less. (Reproducing a selection by hand:
// diff against this parent, not against `git merge-base main HEAD`.)
//
// Any git command failing here - not just an unplaceable merge-base - falls
// back to running every package in full: a diff this can't actually read is
// exactly the case "nothing in the import graph can be trusted to attribute"
// already exists to catch, and treating a failed `git diff` as "nothing
// changed" would silently select too little rather than too much.
//
// Packages run concurrently, up to a limit, all of them always to completion
// rather than one at a time stopping at the first failure: `pnpm -r test`,
// what this replaces, defaults to running independent packages in parallel
// too, and a sequential stop-on-first-failure loop would report fewer
// failures per push than the command it replaces did. Unbounded concurrency
// was tried first and cost a real CI run: five vitest processes at once
// (apps/api's own workerd runtime among them) starved a fully-mocked,
// five-second-budget tools/ci-stability test of CPU on a standard GitHub
// runner, timing it out on nothing it was actually waiting on - a genuine
// regression `pnpm -r`'s own bounded concurrency never produced. The cap
// below is what keeps the speed this exists for without reproducing that.
//

import { readFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { planTestRun } from './lib/test-selection.mjs';
import { testablePackages } from './lib/workspace.mjs';
import { command, paint, start } from './lib/processes.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Trimmed stdout from `file args...`, run in `root`. Throws with its stderr on a non-zero exit or a spawn failure. */
function capture(file, args) {
  const result = spawnSync(file, args, { cwd: root, encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${file} ${args.join(' ')} failed: ${(result.stderr ?? '').trim() || `exit ${result.status}`}`);
  return result.stdout.trim();
}

const git = (args) => capture('git', args);

/** Every workspace package pnpm itself reports, parsed. Goes through command() for the same Windows .cmd handling `run`/`start` use. */
function pnpmWorkspaceList() {
  const { file, args, options } = command(['-r', 'list', '--depth', '-1', '--json']);
  const result = spawnSync(file, args, { cwd: root, encoding: 'utf8', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`pnpm -r list failed: ${(result.stderr ?? '').trim() || `exit ${result.status}`}`);
  return JSON.parse(result.stdout);
}

/**
 * `{ mergeBase, changedFiles }` for a pull_request event, or both empty where
 * anything needed to place them can't be read - which planTestRun already
 * treats as "run everything", the same as an event that isn't a pull request.
 */
function place(event) {
  if (event !== 'pull_request') return { mergeBase: null, changedFiles: [] };
  try {
    // Oldest-parent-first: `[base, head]` for the synthetic merge commit a
    // pull_request event checks out, `[parent]` for an ordinary commit.
    const parents = git(['rev-list', '--parents', '-n', '1', 'HEAD']).split(/\s+/).slice(1);
    if (parents.length !== 2) return { mergeBase: null, changedFiles: [] };
    const mergeBase = parents[0];
    const changedFiles = git(['diff', '--name-only', mergeBase, 'HEAD']).split('\n').filter(Boolean);
    return { mergeBase, changedFiles };
  } catch (error) {
    console.error(paint('33', `Could not place a merge-base (${error.message}); running every package in full.`));
    return { mergeBase: null, changedFiles: [] };
  }
}

let packages;
try {
  packages = testablePackages(pnpmWorkspaceList(), (pkgPath) => JSON.parse(readFileSync(join(pkgPath, 'package.json'), 'utf8')), root);
} catch (error) {
  console.error(paint('31', `\nCould not read the workspace: ${error.message}`));
  process.exit(1);
}

const event = process.env.GITHUB_EVENT_NAME ?? '';
const { mergeBase, changedFiles } = place(event);
const plan = planTestRun({ event, mergeBase, changedFiles, packages });

console.log(
  plan.packages.some((pkg) => pkg.mode === 'changed')
    ? paint('2', `Selecting tests against the merge-base with main, ${mergeBase.slice(0, 7)}:`)
    : paint('2', 'Running every package’s tests in full:'),
);
for (const pkg of plan.packages) console.log(paint('2', `  ${pkg.name}: ${pkg.mode}`));

const COLORS = ['36', '35', '33', '32', '31', '34'];

/** Runs one package's suite; resolves with its exit code, never rejects. */
function runOne(pkg, index) {
  const args = ['--filter', pkg.name, 'test'];
  // --passWithNoTests: a package the PR never touches routinely has zero
  // files left once --changed narrows it. Vitest 4's own default already
  // exits 0 for that (confirmed by hand against this repo's pinned version -
  // "No test files found, exiting with code 0"), but nothing pins that
  // default, and the one time it changes upstream is not a moment to
  // discover a package the PR never touched failing the job on its behalf.
  if (pkg.mode === 'changed') args.push('--changed', mergeBase, '--passWithNoTests');
  const child = start(args, `${pkg.name} (${pkg.mode})`, COLORS[index % COLORS.length], root);

  return new Promise((resolve) => {
    let settled = false;
    // A child can fire both 'error' and 'close' for the same failure (a spawn
    // error such as a missing binary does, on POSIX) - counted once.
    const settle = (code) => {
      if (settled) return;
      settled = true;
      resolve(code ?? 1);
    };
    // Defensive, as supervise() in processes.mjs is: a child that exited
    // before this listener attached would otherwise never settle.
    if (child.exitCode !== null || child.signalCode !== null) settle(child.exitCode ?? 1);
    // 'close', not 'exit': what guarantees start()'s buffered last line has
    // actually been printed before this package is considered done.
    else {
      child.on('close', settle);
      child.on('error', () => settle(1));
    }
  });
}

/**
 * Runs every package to completion - never short-circuits on the first
 * failure - at most `limit` at once, and names the ones that failed.
 *
 * A fixed-size pool of workers pulling from a shared queue, rather than
 * starting everything and letting the OS schedule it: that is exactly what
 * ran five processes at once and starved a lightweight test of CPU on a real
 * runner (see this file's own top comment). `Math.max(1, cpus().length - 1)`
 * leaves one core for the runner itself, capped at packages.length so a
 * five-core box does not still open a worker with nothing left to pull.
 */
async function runAll(allPackages) {
  const queue = [...allPackages];
  const failed = [];
  const limit = Math.max(1, Math.min(allPackages.length, cpus().length - 1));

  async function worker() {
    for (let pkg = queue.shift(); pkg; pkg = queue.shift()) {
      const code = await runOne(pkg, allPackages.indexOf(pkg));
      if (code !== 0) failed.push(pkg.name);
    }
  }

  await Promise.all(Array.from({ length: limit }, worker));
  return failed;
}

const failed = await runAll(plan.packages);
if (failed.length > 0) {
  console.error(paint('31', `\n${failed.join(', ')} failed.`));
  // process.exitCode rather than process.exit(): stdout/stderr are pipes on
  // CI, where a write is asynchronous - process.exit() can end the process
  // before this line (or a slower child's last buffered line) has actually
  // been flushed, losing exactly the output a failed run needs read.
  process.exitCode = 1;
}
