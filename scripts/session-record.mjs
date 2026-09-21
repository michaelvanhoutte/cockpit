#!/usr/bin/env node
//
// The I/O around scripts/lib/session-record.mjs. Everything that decides
// anything is in the module; this finds the record's file, reads the clock
// through the module's default, and moves a pull request body from stdin to
// stdout.
//
// Usage:
//   node scripts/session-record.mjs mark <phase> [<kind> <level>]
//   node scripts/session-record.mjs body < body.md > body-with-record.md
//
//   e.g.  mark start          mark review-start code-review high
//
// The record is a file per branch in this worktree's own git directory, so it
// is never tracked, two worktrees never share one, and a branch started after
// another in the same worktree begins empty. `body` prints its input
// unchanged where nothing has been marked.
//

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { applyBlock, markPhase, parseRecord, recordFileName, renderBlock, serialiseRecord } from './lib/session-record.mjs';

const gitDir = execFileSync('git', ['rev-parse', '--absolute-git-dir'], { encoding: 'utf8' }).trim();
const branch = spawnSync('git', ['symbolic-ref', '--short', '-q', 'HEAD'], { encoding: 'utf8' }).stdout.trim() || 'detached';
const recordFile = join(gitDir, recordFileName(branch));
const entries = () => (existsSync(recordFile) ? parseRecord(readFileSync(recordFile, 'utf8')) : []);

const [command, ...words] = process.argv.slice(2);

try {
  if (command === 'mark') {
    const marked = markPhase(entries(), words);
    writeFileSync(recordFile, serialiseRecord(marked));
    const { at, phase } = marked.at(-1);
    console.log(`${at} ${phase}`);
  } else if (command === 'body' && words.length === 0) {
    process.stdout.write(applyBlock(readFileSync(0, 'utf8'), renderBlock(entries())));
  } else {
    console.error('Usage: node scripts/session-record.mjs mark <phase> [<kind> <level>]\n       node scripts/session-record.mjs body < body.md');
    process.exit(2);
  }
} catch (error) {
  console.error(error.message);
  process.exit(2);
}
