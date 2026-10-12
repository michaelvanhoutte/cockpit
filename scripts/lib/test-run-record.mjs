//
// A test runner writing down its own run on the branch's session record
// ("Record local test runs and the browser pass on the pull request", issue
// 1007): one line when the run ends, naming its scope and the time it began and
// ended. The record file is scripts/lib/session-record.mjs's; this is the I/O
// every runner shares, so Vitest, Playwright and Node's test runner differ only
// in when they call it.
//
// **A runner never creates the record, and never fails for it.** Where the
// branch has no record file (CI, a branch no session started) nothing is
// written; a write that fails is dropped. One `appendFileSync` of one whole line
// is what keeps two processes finishing at once from tearing each other's.
//

import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { recordFileName } from './session-record.mjs';

const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

/**
 * Where the record of the branch checked out in `cwd` is kept, and the root of the worktree: `{ file, root }`, whether or not the file exists yet. `null` outside a git repository.
 */
export function locateSessionRecord(cwd) {
  try {
    const [gitDir, root] = git(cwd, ['rev-parse', '--absolute-git-dir', '--show-toplevel']).split(/\r?\n/);
    let branch = 'detached';
    try {
      branch = git(cwd, ['symbolic-ref', '--short', '-q', 'HEAD']) || branch;
    } catch {
      // A detached HEAD has no branch name; its record is "detached".
    }
    return { file: join(gitDir, recordFileName(branch)), root };
  } catch {
    return null;
  }
}

/** The line a run is kept as in the record file. */
export const runEntry = ({ scopes, start, end }) => ({ run: 'test', scopes, start: new Date(start).toISOString(), end: new Date(end).toISOString() });

/**
 * Records a run that took `start` to `end` (epoch milliseconds or Dates) over `scopes`, where this branch has a record. Never throws.
 */
export function recordTestRun({ scopes, start, end }, cwd = process.cwd()) {
  try {
    const where = locateSessionRecord(cwd);
    if (!where || !existsSync(where.file)) return;
    appendFileSync(where.file, `${JSON.stringify(runEntry({ scopes, start, end }))}\n`);
  } catch {
    // The run passes or fails on its tests alone.
  }
}

/**
 * The scope of one Vitest run: the file where a single file ran out of a package that has more, else the package. `files` are the ones that ran and `known` every one the package has, both relative to `root`.
 */
export function vitestScope({ packageName, files, known }) {
  return files.length === 1 && known.length > 1 ? files[0] : packageName;
}
