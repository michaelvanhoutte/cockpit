#!/usr/bin/env node
//
// `pnpm harness:upload`: sends the Harness Monitor every request in this
// repository's local Claude Code logs, as the usage hook would have, marked as
// an upload (Upload past Claude Code session logs to the Harness Monitor,
// issue 975). Safe to re-run: the monitor ignores a request it already stores.
// The I/O around scripts/lib/usage-upload.mjs; discovery is `pnpm cost:issue`'s.
//
// Needs HARNESS_WRITE_KEY and HARNESS_MONITOR_URL in the environment, as the
// hook does (docs/deployment.md). Exits 1 when a batch was refused or the run
// stopped early.
//

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { mainSessionFilesIn, subagentFilesUnder, thisRepoProjectDirs } from './lib/issue-cost.mjs';
import { parseRecord, recordFileName } from './lib/session-record.mjs';
import { readLog, whereItRan } from './lib/usage-report.mjs';
import { postBatches, summarizeUpload, uploadRows } from './lib/usage-upload.mjs';

const key = process.env.HARNESS_WRITE_KEY;
const url = process.env.HARNESS_MONITOR_URL;
if (!key || !url) {
  console.error('Set HARNESS_WRITE_KEY and HARNESS_MONITOR_URL first (docs/deployment.md, "Where the usage hook finds the key").');
  process.exit(2);
}

// `--path-format=absolute` for the same reason as pnpm cost:issue: the main checkout answers a relative `.git`.
const repoRoot = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' })
  .trim()
  .replace(/[/\\]\.git$/, '');

const claudeDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
const projectsDir = join(claudeDir, 'projects');
if (!existsSync(projectsDir)) {
  console.error(`no session logs at ${projectsDir} - is this the machine that ran the work?`);
  process.exit(1);
}

// Session-record marks live in each worktree's own git directory, so read every worktree that still exists.
const worktreeGitDirs = [];
for (const line of execFileSync('git', ['worktree', 'list', '--porcelain'], { encoding: 'utf8' }).split('\n')) {
  if (!line.startsWith('worktree ')) continue;
  try {
    worktreeGitDirs.push(execFileSync('git', ['-C', line.slice('worktree '.length), 'rev-parse', '--absolute-git-dir'], { encoding: 'utf8' }).trim());
  } catch {
    // A worktree whose directory has gone has no marks to read.
  }
}
const marksByBranch = new Map();
const marksOf = (branch) => {
  if (!marksByBranch.has(branch)) {
    marksByBranch.set(
      branch,
      worktreeGitDirs.flatMap((gitDir) => {
        try {
          return parseRecord(readFileSync(join(gitDir, recordFileName(branch)), 'utf8'));
        } catch {
          return [];
        }
      }),
    );
  }
  return marksByBranch.get(branch);
};

const ranWhere = whereItRan(process.env);
let unreadable = 0;
let unreadableFiles = 0;
const read = (path, sessionId, subagent) => {
  try {
    const log = readLog(readFileSync(path, 'utf8'));
    unreadable += log.unreadable;
    return [{ lines: log.lines, sessionId, subagent }];
  } catch {
    unreadableFiles += 1;
    console.error(`could not read ${path}`);
    return [];
  }
};

// One session at a time, so only its rows outlive it rather than every log's lines.
const rows = [];
const seen = new Set();
for (const dir of thisRepoProjectDirs(repoRoot, projectsDir)) {
  for (const { path, sessionId } of mainSessionFilesIn(dir)) {
    const logs = [
      ...read(path, sessionId, false),
      ...subagentFilesUnder(join(dir, sessionId)).flatMap((sub) => read(sub.path, sessionId, true)),
    ];
    for (const row of uploadRows(logs, { ranWhere, marksOf })) {
      if (seen.has(row.requestId)) continue;
      seen.add(row.requestId);
      rows.push(row);
    }
  }
}

const endpoint = new URL('/v1/usage', url);
const totals = await postBatches(rows, async (batch) => {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ rows: batch }),
    signal: AbortSignal.timeout(60_000),
  });
  if (response.ok) {
    const body = await response.json();
    if (!Number.isSafeInteger(body.stored) || !Number.isSafeInteger(body.ignored)) throw new Error('the monitor answered without counts');
    return { stored: body.stored, ignored: body.ignored };
  }
  // Refused as malformed (400, 413 when too large): retrying the same batch cannot help.
  if (response.status === 400 || response.status === 413) return 'rejected';
  throw new Error(`the monitor answered ${response.status}`);
});

for (const line of summarizeUpload({ ...totals, unreadable, unreadableFiles })) console.log(line);
process.exitCode = totals.refused || totals.failed ? 1 : 0;
