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
// The record is a file in this worktree's own git directory, so it is never
// tracked and two worktrees never share one. `body` prints its input
// unchanged where nothing has been marked.
//

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { applyBlock, markPhase, parseRecord, renderBlock, serialiseRecord } from './lib/session-record.mjs';

const gitDir = execFileSync('git', ['rev-parse', '--absolute-git-dir'], { encoding: 'utf8' }).trim();
const recordFile = join(gitDir, 'cockpit-session-record.jsonl');
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
