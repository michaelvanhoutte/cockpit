#!/usr/bin/env node
//
// Reap the branches that trunk-based development leaves behind: `pnpm branches:tidy`.
//
// Nothing here runs in CI, and nothing here runs on a schedule. It is a manual
// housekeeping command, because every decision it makes is about *this*
// machine's working copy, and CI has no local branches or worktrees to tidy.
//
// The problem it solves is specific to squash-merging. `git branch --merged`
// asks "is this branch's tip an ancestor of main", and under the squash-merge
// rule in docs/deployment.md §1 the answer is permanently *no*: the branch's
// commits never appear on the trunk, only a new single commit with their
// content. So the obvious cleanup command silently reports that every merged
// branch is unmerged, and a `git branch -d` sweep deletes nothing.
//
// What works instead is to let GitHub answer the question. The repository has
// `delete_branch_on_merge` enabled, so merging a PR deletes its remote branch.
// A local branch whose upstream has disappeared is therefore a branch whose PR
// was merged (or whose remote was deleted deliberately), and git records
// exactly that as the `[gone]` tracking state. That is the signal this script
// acts on, and it is only trustworthy *because* the repository setting is on.
//
// What it does, in order:
//   1. `git fetch --prune`, so the `[gone]` states are current rather than
//      reflecting whenever this worktree last talked to the remote.
//   2. Deletes every local branch whose upstream is gone. This needs `-D`
//      rather than `-d`, for the squash-merge reason above; the safety does not
//      come from git's merge check but from the upstream having been reaped.
//   3. `git worktree prune`, which drops the administrative files for
//      worktrees whose directory no longer exists. It never deletes a
//      directory, so an archived Claude session that left its folder behind
//      still needs removing by hand.
//   4. Reports, without deleting, the local branches that have no upstream at
//      all. These are the abandoned sessions: work that was never pushed, so
//      nothing on the remote can vouch for whether it matters. That judgement
//      is not automatable and the script does not pretend otherwise.
//
// Never deletes: `main`, the branch checked out here, or any branch checked out
// in another worktree (git refuses, and the refusal is reported rather than
// swallowed). Pass --dry-run to see the plan without touching anything.

import { execFileSync } from 'node:child_process';

const dryRun = process.argv.includes('--dry-run');

/** Run a git command and return trimmed stdout. */
function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

/** Run a git command for its effect, streaming output, returning success. */
function tryGit(...args) {
  try {
    execFileSync('git', args, { stdio: 'pipe' });
    return { ok: true };
  } catch (error) {
    return { ok: false, message: (error.stderr?.toString() ?? error.message).trim() };
  }
}

// Branches checked out in *any* worktree, including this one. `git branch -D`
// already refuses these, but naming them up front turns a confusing error into
// an explanation, and this repository normally has several worktrees live.
function checkedOutBranches() {
  const out = git('worktree', 'list', '--porcelain');
  const branches = new Map();
  let dir = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) dir = line.slice('worktree '.length);
    else if (line.startsWith('branch ')) {
      branches.set(line.slice('branch refs/heads/'.length), dir);
    }
  }
  return branches;
}

console.log(dryRun ? '· dry run: nothing will be deleted\n' : '');

// 1. Refresh, so [gone] means gone as of now.
process.stdout.write('Fetching…');
const fetched = tryGit('fetch', '--prune');
console.log(fetched.ok ? ' done' : ` failed\n${fetched.message}`);
if (!fetched.ok) process.exit(1);

const checkedOut = checkedOutBranches();

// 2. Classify every local branch by its upstream tracking state.
const gone = [];
const neverPushed = [];
for (const line of git(
  'for-each-ref',
  '--format=%(refname:short)\t%(upstream)\t%(upstream:track)',
  'refs/heads',
).split('\n')) {
  if (!line) continue;
  const [name, upstream, track] = line.split('\t');
  if (name === 'main') continue;
  if (track === '[gone]') gone.push(name);
  else if (!upstream) neverPushed.push(name);
}

// 3. Delete the reaped ones.
if (gone.length === 0) {
  console.log('\nNo merged branches to reap.');
} else {
  console.log(`\nMerged upstream, reaping ${gone.length}:`);
  for (const name of gone) {
    const worktree = checkedOut.get(name);
    if (worktree) {
      console.log(`  skipped  ${name}  (checked out in ${worktree})`);
      continue;
    }
    if (dryRun) {
      console.log(`  would delete  ${name}`);
      continue;
    }
    const result = tryGit('branch', '-D', name);
    console.log(result.ok ? `  deleted  ${name}` : `  FAILED   ${name}: ${result.message}`);
  }
}

// 4. Drop metadata for worktree directories that no longer exist.
if (!dryRun) tryGit('worktree', 'prune');

// 5. Report what cannot be decided mechanically.
if (neverPushed.length > 0) {
  console.log(`\nNever pushed — decide these by hand (${neverPushed.length}):`);
  for (const name of neverPushed) {
    const worktree = checkedOut.get(name);
    console.log(`  ${name}${worktree ? `  (live worktree: ${worktree})` : ''}`);
  }
  console.log('\n  No remote branch and no PR, so nothing can vouch for this work.');
  console.log('  Open a PR if it matters, or: git branch -D <name>');
}
