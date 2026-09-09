//
// The I/O around scripts/lib/review-gate.mjs, for the code review's assert
// step - the sibling of assert-security-review.mjs, over the same module.
// Everything that decides anything is in the module, which node --test covers
// in the Scripts CI job; this reads a file, asks GitHub two questions, prints,
// and sets an exit code, so there is nothing here for a test to hold.
//
// Usage: node scripts/assert-code-review.mjs <execution-file> <conclusion>
//

import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';

import { decideCodeReviewOutcome, oneLine, postedCommentTestApplies, reviewerCommentCount } from './lib/review-gate.mjs';

const [executionFile, conclusion] = process.argv.slice(2);
const repo = process.env.GITHUB_REPOSITORY;
const pr = process.env.PR_NUMBER;

const gh = (args) => execFileSync('gh', args, { encoding: 'utf8', env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });

/**
 * Whether this pull request is one the review was obliged to speak on, or null
 * when GitHub could not be asked.
 *
 * Both non-answers mean the same thing to the gate - skip the posted-comment
 * test - and they mean different things to a person, so the failure says so
 * rather than passing quietly as "not open".
 */
function pullRequestState() {
  if (!repo || !pr) return null;
  try {
    const { state, isDraft } = JSON.parse(gh(['pr', 'view', pr, '--repo', repo, '--json', 'state,isDraft']));
    return { state, isDraft };
  } catch (error) {
    console.log(`::warning::Could not ask GitHub whether this pull request is open, so the posted-comment check is skipped: ${error.message}`);
    return null;
  }
}

/**
 * How many of the pull request's comments and reviews are the reviewer's own.
 *
 * Three endpoints because a review posts through three: a summary comment is an
 * issue comment, a finding on a line is a pull request comment, and a submitted
 * review is neither.
 *
 * A failure here counts as zero, which is red. That is the same answer the
 * bash this replaces gave, and it is the right way round: a gate that cannot
 * see whether the review spoke has not established that it did.
 */
function reviewerSaid() {
  const endpoints = [
    `repos/${repo}/issues/${pr}/comments`,
    `repos/${repo}/pulls/${pr}/comments`,
    `repos/${repo}/pulls/${pr}/reviews`,
  ];
  let logins = '';
  for (const endpoint of endpoints) {
    try {
      logins += `${gh(['api', endpoint, '--paginate', '--jq', '.[].user.login'])}\n`;
    } catch (error) {
      console.log(`::warning::Could not read ${endpoint}: ${error.message}`);
    }
  }
  return reviewerCommentCount(logins);
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

const pullRequest = pullRequestState();
// The gate decides this too, and has the tests. Asked here only because the
// answer is what says whether three paginated API calls are worth making.
const applies = postedCommentTestApplies(pullRequest);
const outcome = decideCodeReviewOutcome({
  executionText,
  conclusion,
  pullRequest,
  said: applies ? reviewerSaid() : 0,
});

const summary = ['## Claude review gate', ''];
summary.push('| field | value |', '| --- | --- |');
summary.push(`| subtype | ${outcome.subtype} |`);
summary.push(`| is_error | ${outcome.isError} |`);
summary.push(`| num_turns | ${outcome.turns} |`);
summary.push(`| permission denials | ${outcome.denials.count} |`);
summary.push('', `The session's closing words: ${oneLine(outcome.finalText)}`, '');
summary.push(
  applies
    ? `- Claude has ${outcome.said} comment(s) on this pull request.`
    : `- Skipping the posted-comment check: this pull request is not open for review${pullRequest ? ` (${pullRequest.state}, draft ${pullRequest.isDraft})` : ', and GitHub could not be asked which it is'}, which the review is entitled to skip.`,
);

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
  summary.push(`- OK: ${outcome.turns} turns, no unexplained denials, and nothing says the review did not happen.`);
} else {
  console.log('::error::Marking this check red. A green claude-review must mean the pull request was actually reviewed.');
}

if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary.join('\n')}\n`);
}

// Set, not process.exit(). On a runner stdout is a pipe, which Node writes to
// asynchronously, and exiting in the same tick can kill the process before the
// annotations above have drained - a red check with nothing saying why, which
// is the one failure a gate whose whole purpose is legibility cannot afford.
process.exitCode = outcome.ok ? 0 : 1;
