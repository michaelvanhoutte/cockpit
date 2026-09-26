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
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { walksIn } from './lib/e2e-ceilings.mjs';
import { buildE2eRecord, renderE2eSummary } from './lib/e2e-record.mjs';
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

// Where the record of this run goes (e2e-record.mjs), uploaded by the E2E job.
const recordDir = process.env.E2E_RECORD_DIR ?? join(root, 'e2e-record');
const reportFile = join(recordDir, 'playwright.json');

/** Runs Playwright with `args`, output inherited and a JSON report beside it for the record; returns its exit code. */
function playwright(args) {
  const all = [`--reporter=${process.env.CI ? 'github,list' : 'list'},json`, ...args];
  const quoted = shell ? all.map((arg) => (/[\s|()]/.test(arg) ? `"${arg}"` : arg)) : all;
  const env = { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: reportFile };
  return spawnSync('pnpm', ['exec', 'playwright', 'test', ...quoted], { cwd: root, stdio: 'inherit', shell, env }).status ?? 1;
}

const event = process.env.GITHUB_EVENT_NAME ?? '';
const { mergeBase, changedFiles } = placeMergeBase(event, (args) => capture('git', args), (message) => console.error(paint('33', message)));

let plan;
let walks = [];
try {
  const packages = testablePackages(pnpmWorkspaceList(root), (pkgPath) => JSON.parse(readFileSync(join(pkgPath, 'package.json'), 'utf8')), root);
  const { concepts } = JSON.parse(readFileSync(join(root, 'tools/test-explorer/concepts.json'), 'utf8'));
  // `--list` starts no stack and needs no browser (scripts/e2e-ceilings.mjs).
  walks = walksIn(JSON.parse(capture('pnpm', ['exec', 'playwright', 'test', '--list', '--reporter=json'])));
  plan = planE2eRun({ event, mergeBase, changedFiles, concepts, walks, packages });
} catch (error) {
  // A selection that cannot be made is never a reason to run less.
  console.error(paint('33', `Could not plan a selection (${error.message}); running every walk.`));
  plan = { mode: 'full', reason: 'the selection failed', forced: { rule: 'the selection failed', path: null } };
}

/**
 * Writes the record and its step summary. Never throws and never touches the
 * exit code: what the walks made the job is what it stays, and a record that
 * could not be written is a warning saying so ("recording never changes the
 * job's outcome", issue 539, which this follows).
 */
function writeRecord() {
  try {
    let report = null;
    try {
      report = JSON.parse(readFileSync(reportFile, 'utf8'));
    } catch {
      // No report: Playwright died before writing one, and the record says so.
    }
    const record = buildE2eRecord({ event, baseCommit: mergeBase, changedFiles, plan, walks, report });
    writeFileSync(join(recordDir, 'record.json'), `${JSON.stringify(record, null, 2)}\n`);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${renderE2eSummary(record)}\n`);
  } catch (error) {
    console.error(paint('33', `\nThe E2E selection record could not be written (${error.message}); this run's result is unchanged.`));
    if (process.env.GITHUB_ACTIONS) console.log(`::warning::The E2E selection record is missing from this run: ${error.message}`);
  }
}

mkdirSync(recordDir, { recursive: true });
rmSync(reportFile, { force: true });

let code = 0;
if (plan.mode === 'full') {
  console.log(paint('2', `Running every browser walk (${plan.reason}).`));
  code = playwright([]);
} else if (!plan.grep) {
  console.log(paint('2', `The diff touches no area that owns a browser walk (${plan.areas.join(', ') || 'none'}); nothing to run.`));
} else {
  console.log(paint('2', `Running the browser walks of ${plan.areas.join(', ')}.`));
  code = playwright(['--grep', plan.grep]);
}

writeRecord();
// process.exitCode rather than process.exit(): stdout is a pipe on CI, where a
// write is asynchronous, and the summary above must be flushed first.
process.exitCode = code;
