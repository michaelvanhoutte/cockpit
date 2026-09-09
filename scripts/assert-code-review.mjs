//
// The I/O around scripts/lib/review-gate.mjs, for the code review's assert
// step - the sibling of assert-security-review.mjs, over the same module.
// Everything that decides anything is in the module, which node --test covers
// in the Scripts CI job; this reads a file, asks GitHub what state the pull
// request is in, when the head arrived and what the reviewer has said, prints,
// and sets an exit code, so there is nothing here for a test to hold.
//
// Usage: node scripts/assert-code-review.mjs <execution-file> <conclusion>
//

import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';

import { decideCodeReviewOutcome, oneLine, postedCommentTestApplies, reviewerRemarks } from './lib/review-gate.mjs';

const [executionFile, conclusion] = process.argv.slice(2);
const repo = process.env.GITHUB_REPOSITORY;
const pr = process.env.PR_NUMBER;
const headSha = process.env.HEAD_SHA;

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
    console.log(`::warning::Could not ask GitHub whether this pull request is open, so the posted-comment check is skipped: ${oneLine(error.message)}`);
    return null;
  }
}

/**
 * The commit this run was asked to review and when it came into existence, or
 * null when either could not be established.
 *
 * The SHA is off the event payload rather than the pull request's current head,
 * so it names what the review actually ran against even if another push has
 * landed since. The date costs one API call and is what tells a remark about
 * this head from one about the head before it - see reviewerRemarks.
 */
function headCommit() {
  if (!repo || !headSha) return null;
  try {
    const committedAt = gh(['api', `repos/${repo}/commits/${headSha}`, '--jq', '.commit.committer.date']).trim();
    return committedAt ? { sha: headSha, committedAt } : null;
  } catch (error) {
    console.log(`::warning::Could not ask GitHub when ${headSha.slice(0, 7)} was committed: ${oneLine(error.message)}`);
    return null;
  }
}

/**
 * What the reviewer has said here, in total and about this head.
 *
 * Three endpoints because a review posts through three: a summary comment is an
 * issue comment, a finding on a line is a pull request comment, and a submitted
 * review is neither. One JSON object per line rather than a bare login, because
 * the head test needs each remark's commit and timestamp as well as its author.
 * A review carries `submitted_at` where the two comment kinds carry
 * `created_at`, and reads as never having been made if only one is asked for.
 *
 * A failure here counts as silence, which is red. That is the same answer the
 * bash this replaces gave, and it is the right way round: a gate that cannot
 * see whether the review spoke has not established that it did.
 */
function reviewerSaid(head) {
  const endpoints = [
    `repos/${repo}/issues/${pr}/comments`,
    `repos/${repo}/pulls/${pr}/comments`,
    `repos/${repo}/pulls/${pr}/reviews`,
  ];
  const fields =
    '.[] | {login: .user.login, createdAt: (.created_at // .submitted_at), commitId: .commit_id, originalCommitId: .original_commit_id}';
  let remarks = '';
  for (const endpoint of endpoints) {
    try {
      remarks += `${gh(['api', endpoint, '--paginate', '--jq', fields])}\n`;
    } catch (error) {
      console.log(`::warning::Could not read ${endpoint}: ${oneLine(error.message)}`);
    }
  }
  return reviewerRemarks(remarks, { head });
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
// answer is what says whether four paginated API calls are worth making.
const applies = postedCommentTestApplies(pullRequest);
const head = applies ? headCommit() : null;
const remarks = applies ? reviewerSaid(head) : { total: 0, onHead: 0 };
const outcome = decideCodeReviewOutcome({
  executionText,
  conclusion,
  pullRequest,
  head,
  said: remarks.total,
  saidOnHead: remarks.onHead,
});

const summary = ['## Claude review gate', ''];
summary.push('| field | value |', '| --- | --- |');
summary.push(`| subtype | ${outcome.subtype} |`);
summary.push(`| is_error | ${outcome.isError} |`);
summary.push(`| num_turns | ${outcome.turns} |`);
summary.push(`| permission denials | ${outcome.denials.count} |`);
summary.push('', `The session's closing words: ${oneLine(outcome.finalText)}`, '');
if (!applies) {
  summary.push(
    `- Skipping the posted-comment check: this pull request is not open for review${pullRequest ? ` (${pullRequest.state}, draft ${pullRequest.isDraft})` : ', and GitHub could not be asked which it is'}, which the review is entitled to skip.`,
  );
} else if (head) {
  summary.push(
    `- Claude has ${outcome.said} comment(s) on this pull request, ${outcome.saidOnHead} of them about ${head.sha.slice(0, 7)}, the head this run reviewed.`,
  );
} else {
  summary.push(`- Claude has ${outcome.said} comment(s) on this pull request, and which head they answer could not be established.`);
}

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
