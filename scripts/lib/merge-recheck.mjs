//
// The decision behind scripts/merge-recheck.mjs, which /build runs before every
// merge it makes ("Re-check a pull request against today's main before /build
// merges it", issue 1359). CI tests a branch merged with `main` as of its own
// run, so two pull requests can each pass against a `main` the other has since
// changed and break it together. This re-runs what the gained commits could
// break, on the branch merged with today's `origin/main`, and decides whether
// the merge goes ahead.
//
// **The base CI tested is read from CI's own checkout log**, the line
// `HEAD is now at <merge> Merge <head> into <base>` that actions/checkout
// prints for a pull_request run. That is the `main` tip GitHub merged into the
// branch for that run, exactly. Three other sources were looked at and not
// used: the run's `pull_requests[].base.sha` is empty once the pull request
// has merged and is not shown to be frozen at the run's start; the run's start
// time against `main`'s history is approximate at the edges, in the direction
// that skips a re-check; `refs/pull/<n>/merge` is today's merge, not the run's.
// Where the log cannot be read the caller passes the merge-base of the branch
// and `origin/main` instead, which can only widen what main "gained", never
// narrow it.
//
// What the gained commits are is `base..origin/main` minus whatever the branch
// already contains, so a branch that merged current `main` itself and had CI
// run on it gains nothing.
//
// What runs is chosen by the same two decisions CI uses and not decided again
// here: `productPaths` (scripts/lib/what-changed.mjs) says whether anything
// gained needs a re-check, `planTestRun` (scripts/lib/test-selection.mjs) which
// suites run in full and which only against what changed. On top of those:
// typecheck and the bundle gate whenever product code is among it, API-only
// included: the web build and the gate measured 10s together against 35s for
// typecheck, too little to earn a rule for when it cannot matter. Never E2E.
//
// Everything that touches GitHub, git, pnpm or the clock is an argument, so the
// decision is tested with those replaced. `inMergedTree` is the one piece of
// git behaviour kept here, because what it must leave untouched is the point
// and is proved against a real repository.
//

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';

import { productPaths } from './what-changed.mjs';
import { planTestRun } from './test-selection.mjs';

/** The web workspace package, whose build the bundle gate measures. */
export const WEB_BUILD = ['--filter', '@cockpit/web', 'build'];

/**
 * What to run for the paths `main` gained, or an empty plan where nothing needs
 * re-checking.
 *
 * @param {{ base: string, paths: string[], packages: { name: string, dir: string }[] }} gained
 * @returns {{ checks: object[] }} each `{ kind: 'typecheck' }`, `{ kind: 'bundle' }` or `{ kind: 'suite', pkg, mode, base }`
 */
export function planRecheck({ base, paths, packages }) {
  const product = productPaths(paths);
  if (product.length === 0) return { checks: [] };
  const checks = [{ kind: 'typecheck' }];
  checks.push({ kind: 'bundle' });
  const plan = planTestRun({ event: 'pull_request', mergeBase: base, changedFiles: paths, packages });
  for (const pkg of plan.packages) checks.push({ kind: 'suite', pkg: pkg.name, mode: pkg.mode, base });
  return { checks };
}

/** The size line the bundle gate prints first, for the refusal to quote. */
function bundleSize(output) {
  return /Initial bundle, compressed: .*/.exec(output ?? '')?.[0] ?? 'size not reported';
}

/** One failed check, as the sentence the refusal names it with. */
function nameFailure(check, output) {
  if (check.kind === 'typecheck') return 'typecheck failed';
  if (check.kind === 'bundle') return `the bundle gate failed (${bundleSize(output)})`;
  return `the ${check.pkg} suite failed`;
}

/**
 * The whole decision. Resolves `{ pass, message }`; never throws for a refusal.
 *
 * @param {object} io everything outside the decision
 * @param {() => string} io.head the pull request's head commit
 * @param {() => Promise<string | null>} io.testedBase the `main` tip CI's last run merged in, or null where there is no run
 * @param {() => string} io.tip `origin/main`, freshly fetched
 * @param {(base: string, head: string, tip: string) => string[]} io.gained paths changed by commits in base..tip the head does not contain
 * @param {() => { name: string, dir: string }[]} io.packages
 * @param {(work: (dir: string) => Promise<any>) => Promise<{ conflict: string[] } | { result: any }>} io.inMergedTree runs `work` on head merged with tip
 * @param {(check: object, dir: string) => Promise<{ ok: boolean, output?: string }>} io.run
 */
export async function recheck(io) {
  const head = io.head();
  const base = await io.testedBase();
  if (!base) return { pass: false, message: `Refused: no CI run found for ${head}. Push it and let CI run first.` };

  const tip = io.tip();
  const paths = tip === base ? [] : io.gained(base, head, tip);
  const { checks } = planRecheck({ base, paths, packages: io.packages() });
  if (checks.length === 0) {
    return { pass: true, message: `Pass: main gained nothing that needs a re-check since ${base.slice(0, 7)}, the base CI tested.` };
  }

  const merged = await io.inMergedTree(async (dir) => {
    const failures = [];
    for (const check of checks) {
      const outcome = await io.run(check, dir);
      if (!outcome.ok) failures.push({ text: nameFailure(check, outcome.output), output: outcome.output });
    }
    return failures;
  });
  if (merged.conflict) {
    return { pass: false, message: `Refused: the branch does not merge cleanly with main (${merged.conflict.join(', ') || 'conflict'}).` };
  }
  const failures = merged.result;
  const shown = checks.map((c) => (c.kind === 'suite' ? c.pkg : c.kind)).join(', ');
  if (failures.length === 0) return { pass: true, message: `Pass: ${shown} all green on the branch merged with main ${tip.slice(0, 7)}.` };
  return { pass: false, message: `Refused: ${failures.map((f) => f.text).join('; ')}.`, failures };
}

/** Trimmed stdout of `git args...` in `cwd`. */
function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/**
 * Removes a re-check's worktree however a previous run left it: registered or
 * not, half built or complete.
 */
export function clearWorktree(repo, dir) {
  try {
    git(repo, ['worktree', 'remove', '--force', dir]);
  } catch {
    // Not registered, or already gone.
  }
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  git(repo, ['worktree', 'prune']);
}

/**
 * Runs `work(dir)` in a temporary worktree holding `head` merged with `tip`,
 * and removes it afterwards, including when `work` throws. The merge is never
 * committed: it exists only in that worktree's index, so the repository's
 * branches, its own working tree and its index are never touched, and two calls
 * with different `dir`s never see each other's merge. A `dir` a killed run left
 * behind is cleared first.
 *
 * @returns {Promise<{ conflict: string[] } | { result: any }>}
 */
export async function inMergedTree({ repo, dir, head, tip, prepare = async () => {}, work }) {
  clearWorktree(repo, dir);
  mkdirSync(dirname(dir), { recursive: true });
  try {
    git(repo, ['worktree', 'add', '--detach', dir, head]);
    try {
      git(dir, ['-c', 'user.name=recheck', '-c', 'user.email=recheck@invalid', 'merge', '--no-commit', '--no-ff', tip]);
    } catch (error) {
      const unmerged = git(dir, ['diff', '--name-only', '--diff-filter=U']).split('\n').filter(Boolean);
      if (unmerged.length === 0) throw error;
      return { conflict: unmerged };
    }
    await prepare(dir);
    return { result: await work(dir) };
  } finally {
    clearWorktree(repo, dir);
  }
}

/** The paths changed by commits in `base..tip` that `head` does not contain. */
export function gainedPaths(repo, base, head, tip) {
  const out = execFileSync('git', ['log', '--format=', '--name-only', '--no-renames', '-z', `${base}..${tip}`, `^${head}`], {
    cwd: repo,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return [...new Set(out.split('\0').filter((p) => p.trim() !== ''))];
}

/** The `main` tip a CI checkout log says it merged the head into, or null. */
export function baseFromCheckoutLog(log, head) {
  return new RegExp(`Merge ${head} into ([0-9a-f]{40})`).exec(String(log ?? ''))?.[1] ?? null;
}
