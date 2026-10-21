#!/usr/bin/env node
//
// The I/O around scripts/lib/merge-recheck.mjs, which holds every decision and
// says how the base CI tested is found. /build runs this with the pull request
// number before every merge it makes and merges only on exit 0.
//
// Usage: node scripts/merge-recheck.mjs <pull request number>
//
// Exit 0: nothing to re-check, or the re-check passed. Exit 1: refused, with
// what failed on the last line. Nothing is committed or pushed, and this
// session's branch and working tree are never touched: the merge exists in a
// temporary worktree under the OS temp directory, removed afterwards and
// cleared first if a killed run left it.
//

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { baseFromCheckoutLog, gainedPaths, inMergedTree, recheck, WEB_BUILD } from './lib/merge-recheck.mjs';
import { command, pnpmWorkspaceList } from './lib/processes.mjs';
import { testablePackages } from './lib/workspace.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const number = process.argv[2];
if (!/^\d+$/.test(number ?? '')) {
  console.error('Usage: node scripts/merge-recheck.mjs <pull request number>');
  process.exit(2);
}

function sh(file, args, options = {}) {
  const result = spawnSync(file, args, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${file} ${args.join(' ')} failed: ${(result.stderr ?? '').trim() || `exit ${result.status}`}`);
  return result.stdout.trim();
}

const git = (...args) => sh('git', args);
const gh = (...args) => sh('gh', args);

git('fetch', '--quiet', 'origin', 'main');
git('fetch', '--quiet', 'origin', `refs/pull/${number}/head`);
const head = git('rev-parse', 'FETCH_HEAD');
const tip = git('rev-parse', 'origin/main');

/** The `main` tip the newest pull_request run for `head` merged in, from its checkout log; the branch's merge-base with main where that log cannot be read. Null where no run exists. */
async function testedBase() {
  const runs = JSON.parse(gh('api', `repos/{owner}/{repo}/actions/runs?head_sha=${head}&event=pull_request&per_page=30`, '--jq', '.workflow_runs'));
  if (runs.length === 0) return null;
  const newest = runs.sort((a, b) => b.created_at.localeCompare(a.created_at) || b.run_attempt - a.run_attempt)[0];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const jobs = JSON.parse(gh('api', `repos/{owner}/{repo}/actions/runs/${newest.id}/jobs?per_page=1`, '--jq', '.jobs'));
      const log = gh('api', `repos/{owner}/{repo}/actions/jobs/${jobs[0].id}/logs`);
      const base = baseFromCheckoutLog(log, head);
      if (base) return base;
    } catch {
      // Retried once, then the conservative base below.
    }
  }
  console.error('Could not read the base from the CI log; using the branch\'s merge-base with main, which re-checks at least as much.');
  return git('merge-base', head, tip);
}

const dir = join(tmpdir(), 'cockpit-recheck', `${createHash('sha1').update(root).digest('hex').slice(0, 8)}-pr${number}`);

/** Output tail on a failure, so the refusal can be acted on without re-running. */
function tail(text) {
  return String(text).split('\n').slice(-40).join('\n');
}

function pnpm(args, cwd) {
  const { file, args: rest, options } = command(args);
  const result = spawnSync(file, rest, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...options });
  return { ok: result.status === 0, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

async function prepare(where) {
  const started = Date.now();
  const install = pnpm(['install', '--frozen-lockfile', '--prefer-offline'], where);
  console.log(`Installed dependencies in ${((Date.now() - started) / 1000).toFixed(0)}s.`);
  if (!install.ok) throw new Error(`pnpm install failed in the re-check worktree:\n${tail(install.output)}`);
}

async function run(check, where) {
  const started = Date.now();
  let outcome;
  if (check.kind === 'typecheck') outcome = pnpm(['typecheck'], where);
  else if (check.kind === 'bundle') {
    outcome = pnpm(WEB_BUILD, where);
    if (outcome.ok) {
      const gate = spawnSync(process.execPath, ['scripts/bundle-budget.mjs'], { cwd: where, encoding: 'utf8' });
      outcome = { ok: gate.status === 0, output: `${gate.stdout}${gate.stderr}` };
    }
  } else {
    const args = ['--filter', check.pkg, 'test'];
    if (check.mode === 'changed') args.push('--changed', check.base, '--passWithNoTests');
    outcome = pnpm(args, where);
  }
  const label = check.kind === 'suite' ? `${check.pkg} suite (${check.mode})` : check.kind;
  console.log(`${outcome.ok ? 'ok  ' : 'FAIL'} ${label} ${((Date.now() - started) / 1000).toFixed(0)}s`);
  if (!outcome.ok) console.log(tail(outcome.output));
  return outcome;
}

const result = await recheck({
  head: () => head,
  testedBase,
  tip: () => tip,
  gained: (base, h, t) => gainedPaths(root, base, h, t),
  packages: () => testablePackages(pnpmWorkspaceList(root), (p) => JSON.parse(readFileSync(join(p, 'package.json'), 'utf8')), root),
  inMergedTree: (work) => inMergedTree({ repo: root, dir, head, tip, prepare, work }),
  run,
});

console.log(result.message);
process.exit(result.pass ? 0 : 1);
