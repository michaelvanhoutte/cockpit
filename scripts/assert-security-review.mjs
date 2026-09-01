//
// The I/O around scripts/lib/review-gate.mjs, for the security review's assert
// step. Everything that decides anything is in the module, which node --test
// covers in the Scripts CI job; this reads a file, prints, and sets an exit
// code, so there is nothing here for a test to hold.
//
// Usage: node scripts/assert-security-review.mjs <execution-file> <conclusion>
//

import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';

import { COMMENT_MARKER, decideOutcome, summaryComment } from './lib/review-gate.mjs';
import { upsertSticky } from './lib/sticky-comment.mjs';

const [executionFile, conclusion] = process.argv.slice(2);

/**
 * Leave the verdict on the pull request, editing the note this workflow left
 * last time rather than adding another.
 *
 * Deliberately never fatal. The verdict is what the check is about, and turning
 * a clean review red because a comment could not be posted would be the gate
 * failing for a reason that has nothing to do with the code - the exact
 * behaviour it exists to refuse in the reviewer.
 */
function leaveSummary(outcome) {
  const repo = process.env.GITHUB_REPOSITORY;
  const pr = process.env.PR_NUMBER;
  if (!repo || !pr) return;

  const gh = (args, input) =>
    execFileSync('gh', args, { input, encoding: 'utf8', env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });

  try {
    const { action } = upsertSticky({ gh, repo, pr, marker: COMMENT_MARKER, body: summaryComment(outcome) });
    console.log(`Verdict comment ${action}.`);
  } catch (error) {
    console.log(`::warning::Could not leave the verdict on the pull request: ${error.message}`);
  }
}

let executionText = '';
try {
  executionText = readFileSync(executionFile, 'utf8');
} catch {
  // Left empty on purpose. A missing file is one of the cases the gate
  // decides - the action sets no outputs at all when it skips itself, and that
  // has to read as "did not run" rather than as a crash here.
  executionText = '';
}

const outcome = decideOutcome({ executionText, conclusion });

const summary = ['## Claude security review gate', ''];
summary.push(`| field | value |`, `| --- | --- |`);
summary.push(`| verdict | ${outcome.verdict ?? 'none given'} |`);
summary.push(`| turns | ${outcome.turns} |`);
summary.push(`| permission denials | ${outcome.denials.count} |`);
summary.push('');

// The action sets no outputs at all when it skips itself, and the usual cause
// is its own workflow validation: it refuses to run when this workflow file
// differs from the copy on the default branch, which is true of every pull
// request that edits it. Expected, and still not a review - so the check goes
// red rather than showing a green tick that would imply one happened.
if (!executionFile) {
  console.log(
    '::notice::The review step produced no output file, so it never started. On a pull request that ' +
      'edits this workflow, that is the action refusing to run a version of itself that is not yet on ' +
      'the default branch. Expected there, and it still means this pull request was not reviewed.',
  );
}

for (const warning of outcome.warnings) {
  console.log(`::warning::${warning}`);
  summary.push(`- Warning: ${warning}`);
}
for (const failure of outcome.failures) {
  console.log(`::error::${failure}`);
  summary.push(`- FAIL: ${failure}`);
}
if (outcome.ok) {
  summary.push(`- OK: the review reached a verdict of ${outcome.verdict}.`);
}

if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary.join('\n')}\n`);
}

leaveSummary(outcome);

process.exit(outcome.ok ? 0 : 1);
