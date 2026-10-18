#!/usr/bin/env node
//
// The I/O around scripts/lib/session-record.mjs. Everything that decides
// anything is in the module; this finds the record's file, reads the clock
// through the module's default, and moves a pull request body from stdin to
// stdout.
//
// Usage:
//   node scripts/session-record.mjs mark <phase> [<kind> <level> [<count> | <fixed> <declined>] | <outcome>]
//   node scripts/session-record.mjs body < body.md > body-with-record.md
//
//   e.g.  mark start          mark review-start code-review high   mark review-end code-review high 3
//         mark review-outcome code-review high 2 1   (fixed, then declined)   mark ci-start   mark ci-end success
//
// The record is a file per branch in this worktree's own git directory, so it
// is never tracked, two worktrees never share one, and a branch started after
// another in the same worktree begins empty. The test runners append their own
// runs to it (scripts/lib/test-run-record.mjs), so `mark` appends one line too
// rather than rewriting the file under them. `body` prints its input unchanged
// where nothing has been recorded.
//

import { appendFileSync, existsSync, readFileSync } from 'node:fs';

import { applyBlock, markPhase, parseRecord, renderBlock, serialiseRecord } from './lib/session-record.mjs';
import { locateSessionRecord } from './lib/test-run-record.mjs';

const where = locateSessionRecord(process.cwd());
if (where === null) {
  console.error('Not inside a git repository, so there is no session record to read or write.');
  process.exit(2);
}
const recordFile = where.file;
const entries = () => (existsSync(recordFile) ? parseRecord(readFileSync(recordFile, 'utf8')) : []);

const [command, ...words] = process.argv.slice(2);

try {
  if (command === 'mark') {
    // The record is read to check a mark that depends on an earlier one (an outcome, a CI wait's end); only the new mark is appended.
    const [mark] = markPhase(entries(), words).slice(-1);
    appendFileSync(recordFile, serialiseRecord([mark]));
    console.log(`${mark.at} ${mark.phase}`);
  } else if (command === 'body' && words.length === 0) {
    process.stdout.write(applyBlock(readFileSync(0, 'utf8'), renderBlock(entries())));
  } else {
    console.error('Usage: node scripts/session-record.mjs mark <phase> [<kind> <level> [<count> | <fixed> <declined>] | <outcome>]\n       node scripts/session-record.mjs body < body.md');
    process.exit(2);
  }
} catch (error) {
  console.error(error.message);
  process.exit(2);
}
