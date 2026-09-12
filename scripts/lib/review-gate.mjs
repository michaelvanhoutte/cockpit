//
// Whether a Claude review run actually reached a verdict, and whether that
// verdict is one that should block a merge. Both reviews decide it here - the
// security review through decideSecurityOutcome, the code review through
// decideCodeReviewOutcome - over the same execution record, the same denial
// counting and the same reading of the action's two payload shapes.
//
// This lives here rather than in the workflows because the code review's gate
// was a `run:` block until "Give the code review the tested gate the security
// review already uses" (issue 277) moved it, and every incident recorded in
// that file's comments is a bug in it: a permission_denials_count field missing
// from the result record and read as "no denials", a three-turn blocked session
// passing as clean, a seven-turn one doing the same, a result payload that is
// sometimes an array and sometimes an object. All four are decisions over a
// JSON document, all four shipped green, and none of them was covered by
// anything, because inline bash cannot be run by a test. The same logic in a
// module is asserted by node --test in the Scripts step, like the rest of
// scripts/lib.
//
// Two functions rather than one with a flag, because the two gates ask
// different questions of the same record. The security review is required to
// end with a verdict line, so its gate reads that line and can say what the
// verdict was; the code review has no such contract, and the only evidence it
// reached a verdict at all is that it posted something on the pull request.
//
// Everything here takes its inputs as arguments and reads nothing - no
// filesystem, no environment, no clock - for the same reason stopPlan() in
// processes.mjs takes the platform instead of reading it: a decision that reads
// its own world can only be tested in that world.
//
// What it does NOT do is judge the security of anything. The reviewing is
// Claude's; this only reads what came back.
//

/** Weakest to strongest. A verdict names exactly one of these. */
export const SEVERITIES = ['NONE', 'LOW', 'MEDIUM', 'HIGH'];

/**
 * Hidden marker identifying the security review's comment, so each run edits
 * the one it left last time instead of adding another. A review that comments
 * on every push turns a long pull request into a column of near-identical
 * notices, which is its own way of not being read.
 *
 * The code review's gate leaves no comment of its own: the reviewer's own
 * comments are what it reads to decide the check, and a note from the gate
 * beside them would be the thing it is looking for.
 */
export const COMMENT_MARKER = '<!-- cockpit-security-review -->';

/**
 * Who the gate's own note is posted as. `github.token` authenticates the run as
 * this account, so a note claiming to be the gate's and authored by anyone else
 * is not the gate's - see markedCommentId, where that matters.
 */
export const GATE_AUTHOR = 'github-actions[bot]';

/**
 * What the pull request should say about this run.
 *
 * The workflow posts this rather than asking the reviewer to. The prompt used
 * to ask - "post a short summary comment when you find nothing" - and on the
 * first run that ever reached a verdict it did not, leaving a green check whose
 * only evidence was inside the job log. That is the state this whole gate exists to
 * refuse: from the pull request alone, "reviewed, found nothing" and "never ran"
 * looked identical.
 *
 * Asking harder would have been the obvious fix and the wrong one. The sibling
 * workflow infers a review from whether Claude spoke, and "The review check
 * goes green when the reviewer declined to look at the new commits" (issue 75)
 * is what that inference cost before it was narrowed to the head being
 * reviewed. The gate already knows the verdict; having it say so needs no
 * cooperation from anyone.
 */
export function summaryComment(outcome) {
  // No marker here: upsertSticky prepends it, so that one place decides how a
  // workflow's note is identified and every caller gets the same answer.
  const lines = ['## Security review', ''];

  if (outcome.ok) {
    lines.push(`**Verdict: ${outcome.verdict}.** ${verdictMeaning(outcome.verdict)}`);
  } else {
    lines.push('**This check is red.**', '');
    for (const failure of outcome.failures) lines.push(`- ${failure}`);
  }

  if (outcome.warnings.length > 0) {
    lines.push('', '<details><summary>Worth a look</summary>', '');
    for (const warning of outcome.warnings) lines.push(`- ${warning}`);
    lines.push('', '</details>');
  }

  lines.push(
    '',
    '<sub>Any findings are inline comments on the diff. This note is written by the gate, not by the reviewer, so it appears whether or not the reviewer said anything.</sub>',
  );
  return lines.join('\n');
}

/**
 * Every object in `gh api --paginate --jq` output, skipping any line that will
 * not parse.
 *
 * Line-oriented on purpose, and this is the whole reason both readers below are
 * functions with tests rather than two lines each in a script. `--paginate`
 * applies `--jq` to each page separately and concatenates the results, so a
 * filter that wraps its output in an array emits one array per page -
 * `[...]\n[...]` - which is not JSON and throws when parsed. The first version
 * of markedCommentId did exactly that. It would have worked on every pull
 * request until one passed thirty comments, and then failed inside the try that
 * makes posting non-fatal: no comment, no update of the stale one already
 * there, and a warning nobody reads. A change whose only purpose was making the
 * verdict visible would have stopped doing that invisibly, which is the joke it
 * deserved to be caught for.
 *
 * One JSON object per line concatenates safely, so both gates ask for that
 * shape and read it here.
 */
function* jsonLines(ghOutput) {
  for (const line of String(ghOutput ?? '').split('\n')) {
    if (line.trim() === '') continue;
    try {
      yield JSON.parse(line);
    } catch {
      // One unreadable line is not a reason to abandon the rest: what is being
      // looked for may be on any of them.
      continue;
    }
  }
}

/**
 * The id of the note this workflow left last time, from `gh api --paginate`
 * output, or null if there is none yet.
 */
export function markedCommentId(ghOutput, { marker = COMMENT_MARKER, author = GATE_AUTHOR } = {}) {
  for (const comment of jsonLines(ghOutput)) {
    // The author check is not belt-and-braces. The marker is a public constant
    // in a public repository, GitHub lists comments oldest first, and this
    // returns the first match - so without it, anyone who can comment on a pull
    // request could post the marker before the gate's first run and have every
    // later run PATCH their comment instead of writing its own. The gate holds
    // `pull-requests: write`, so that is someone else's text being overwritten
    // by a token they do not have, and the verdict never appearing at all,
    // which is the exact outcome this whole change exists to prevent.
    if (comment?.login !== author) continue;
    if (String(comment?.body ?? '').includes(marker)) return comment.id;
  }
  return null;
}

/**
 * What a verdict means, said only as far as the gate can actually know it.
 *
 * "The reviewer read the diff and found nothing" was the first wording, and it
 * claims something this cannot see. The gate reads one line; it has no idea how
 * much of the diff that line covers. A review that ran out of room and reported
 * NONE would have been announced here in the same confident words as a thorough
 * one - which is the failure the instructions file calls the one nothing
 * downstream can catch, restated by the thing meant to make it visible.
 *
 * So the note says what was reported, and points at where a coverage caveat
 * would be if there is one: its own comment, which the prompt requires and this
 * cannot generate.
 */
function verdictMeaning(severity) {
  if (severity === 'NONE') {
    return (
      'The reviewer reported nothing. If it could not read the whole diff, it says so in a ' +
      'comment of its own — this note cannot tell you how much was covered.'
    );
  }
  if (severity === 'HIGH') return 'This must not merge as it stands.';
  return `Findings at ${severity} do not block the merge; they are for a person to weigh.`;
}

/**
 * The single line the run is required to end with, anchored to the start of a
 * line so that prose about severities cannot match it.
 *
 * Anchoring is the whole trick. `/security-review` returns prose, and the
 * obvious gate - look for the word "critical" or "high" - passes and fails on
 * the same sentence depending on how it is phrased: "no critical or high
 * severity issues found" contains both words and means the opposite of what
 * grepping for them concludes.
 *
 * Case-insensitive, matching the `.toUpperCase()` applied to the severity
 * below: holding the label to an exact case while normalising the word after it
 * was an asymmetry with no argument behind it, and every way this fails to
 * match costs the same thing - a run that did review reads as one that never
 * reached a verdict, and goes red for a reason unrelated to the code.
 *
 * No `\r?` before the end anchor, deliberately, because a review of this file
 * asked for one. ECMAScript counts `\r` as a line terminator in its own right,
 * so under `m` the `$` already matches before the `\r` of a CRLF ending and a
 * `SECURITY-VERDICT: HIGH\r\n` line matches as it stands. (Measured, not
 * assumed: `/^b$/m.test('a\rb')` is true.) The tolerance would have been dead
 * code justified by a false statement about the language, which is worse than
 * either on its own. The CRLF case is covered by a test regardless, so the day
 * the anchoring changes, that fact is not rediscovered by a red check in CI.
 *
 * None of this loosens what counts as a verdict. The line must still be a
 * line: prose mentioning the label mid-sentence does not match, and two
 * matching lines still fail rather than resolve.
 */
const VERDICT_LINE = /^[ \t]*SECURITY-VERDICT:[ \t]*([A-Za-z]+)[ \t]*$/gim;

/**
 * The result record, from either shape the action emits. It writes a stream of
 * messages as a JSON array on some runs and a single result object on others,
 * and reading only the second is how run 33201638348's denial went unseen.
 *
 * Returns null when there is no result record at all, which is not the same as
 * a result record saying something bad - a run that produced no result did not
 * run.
 */
export function resultRecordOf(execution) {
  if (Array.isArray(execution)) {
    const results = execution.filter((m) => m && m.type === 'result');
    return results.length > 0 ? results[results.length - 1] : null;
  }
  if (execution && typeof execution === 'object') return execution;
  return null;
}

/**
 * How many tool calls were denied, and why.
 *
 * Counted from both places and the higher one wins. The result record's
 * permission_denials_count is absent on some runs while the message stream
 * holds real denials, so trusting the summary alone reads "no denials" off a
 * missing field - which is exactly what happened on run 33201638348 in the
 * sibling workflow.
 *
 * `reasons` is what makes the warning worth reading, and it is one reason per
 * denial, never a wholesale choice between messages and tool names. `tool_name`
 * alone is "Bash" on every denial sampled for issue 284, which said nothing -
 * three of them read as "Bash, Bash, Bash" on pull request 266, run
 * 34236381017, and all three were the same attempt - save the diff to a file
 * to check its size - denied three different ways as Claude Code retried it: a
 * compound command whose sub-command still needed approval, then twice over an
 * output redirection refused outright. The redirection is not a missing
 * allowlist entry - Claude Code refuses writing command output to a file
 * regardless of what is allowlisted - so no tool name could have said that.
 * The denial's own `message` does. Pull request 272, run 34283557786, is the
 * other shape: a subagent shelling out to `grep | head` instead of using the
 * Grep tool it already had, denied as a compound command for the same reason.
 *
 * Falling back to the tool name only per-denial, not for the whole list,
 * matters where some denials in a run carry a message and others do not: a
 * wholesale choice would drop the message-less ones from the reader-facing
 * text entirely, while `count` kept counting them.
 */
export function denialsOf(execution, result) {
  const stream = Array.isArray(execution)
    ? execution.filter((m) => m && m.type === 'system' && m.subtype === 'permission_denied')
    : [];
  const fromSummary = Number(result?.permission_denials_count ?? 0) || 0;
  const count = Math.max(stream.length, fromSummary);
  const reasons = [...new Set(stream.map((m) => oneLine(m.message) || m.tool_name || '?'))];
  return { count, reasons };
}

/**
 * Everything both gates read off the action's execution file, before either of
 * them decides anything with it.
 *
 * `executionText` is the raw contents, parsed here rather than by the caller so
 * that "the file was empty or unparseable" is a case the gates can be asked
 * about instead of a crash in the workflow. `result` is null for a run that
 * produced no result record, which is not the same as a result record saying
 * something bad: a run that produced no result did not run.
 */
function runFacts(executionText) {
  let execution = null;
  try {
    execution = JSON.parse(String(executionText ?? ''));
  } catch {
    execution = null;
  }

  const result = resultRecordOf(execution);
  if (result === null) return { result: null, turns: 0, denials: { count: 0, reasons: [] }, subtype: 'unknown', isError: false, finalText: '' };

  return {
    result,
    turns: Number(result.num_turns ?? 0) || 0,
    denials: denialsOf(execution, result),
    subtype: String(result.subtype ?? 'unknown'),
    isError: result.is_error === true,
    finalText: String(result.result ?? ''),
  };
}

/** The failure both gates give for a run that produced no result record. */
function didNotRun() {
  return {
    ok: false,
    failures: ['The review produced no result record, so it did not run.'],
    warnings: [],
    turns: 0,
    denials: { count: 0, reasons: [] },
  };
}

/**
 * Anything out of the execution record, made safe to put in a message the
 * workflow prints.
 *
 * Two hazards, both because those messages become `::warning::` and `::error::`
 * annotations and the text in them is the model's own output. A newline
 * truncates an annotation at the first one, which is every multi-line closing
 * message; and a line beginning `::` is read by the runner as a workflow
 * command rather than printed, `::stop-commands::` and the silencing of
 * everything after it included. Neither is a way for the gate that exists to be
 * legible to end up.
 */
export function oneLine(text) {
  return String(text ?? '')
    .replace(/\s*[\r\n]+\s*/g, ' ')
    .replace(/::/g, ': :')
    .trim();
}

/**
 * How the denials read once the gate knows whether a verdict landed.
 *
 * Fatal only when nothing landed. Every tool a review needs is allowlisted, so
 * a denial is one deliberately withheld - run 33202686222 was a validation
 * agent reaching for `node -e` to execute the pull request's own logic, which
 * is not something to grant a review of untrusted code on a public repository.
 * It adapted and posted its findings anyway, and failing that run would teach
 * everyone to ignore this check.
 *
 * Names what `denialsOf` found, not just that something was denied - see its
 * own comment for why a reason beats a tool name. Joined with ` | ` rather
 * than `; `, since a denial's reason routinely quotes a shell command and `;`
 * is the one character certain to appear inside one; `|` is not guaranteed
 * absent either, but a run's own commands are more likely to pipe than to
 * embed a literal bar in prose. The reason comes last in the sentence,
 * deliberately: it is arbitrary text this module does not control and cannot
 * assume ends cleanly, and appending anything after it (as the first version
 * of this note did) produced a stray "..blocked.. Worth a look" the one time a
 * sampled message happened to end in a period, which was most of them.
 */
function denialNote(denials, { reachedVerdict }) {
  const which = denials.reasons.join(' | ') || 'see log';
  return reachedVerdict
    ? `Worth a look if its findings seem thin - the review reached a verdict but ${denials.count} tool call(s) were denied: ${which}`
    : `Likely blocked by ${denials.count} permission denial(s): ${which}`;
}

/**
 * The verdict the run ended with.
 *
 * Three outcomes, deliberately distinct: a verdict, `null` for a run that never
 * gave one, and `{ ambiguous }` for a run that gave more than one. Two verdict
 * lines is not a case to resolve by taking the last - a run that stated two
 * answers has not given one, and picking between them invents a result nobody
 * reported. The likeliest cause is the reviewer quoting the required format
 * back while also using it, and guessing which is the real one is how a HIGH
 * gets read as a NONE.
 */
export function verdictOf(text) {
  const found = [...String(text ?? '').matchAll(VERDICT_LINE)].map((m) => m[1].toUpperCase());
  const known = found.filter((s) => SEVERITIES.includes(s));
  if (known.length === 0) return null;
  if (known.length > 1) return { ambiguous: known };
  return { severity: known[0] };
}

/**
 * Whether the security review's check goes green.
 *
 * A failure is always a statement about what is missing, never a bare exit
 * code: this text is what a person reads when the check is red, and "the
 * review produced no verdict" and "the review found something HIGH" are
 * different problems with different fixes.
 *
 * No turn-count warning here, deliberately - the opposite of the sibling
 * gate below. Seven of eight security reviews sampled on pull requests 249,
 * 261, 265, 266, 269, 272 and 273 carried one under a NONE verdict, and their
 * turn counts (4 to 9) tracked nothing about the diff: a 448-line, 5-file
 * pull request took 4 turns and a 556-line, 25-file one took 9, denials
 * included. A warning that fires on almost every review carries no
 * information ("Make the security review warning mean something, or drop
 * it", issue 284) - the reader learns to scroll past it, which is the
 * failure this whole gate exists to prevent, one level up. The verdict
 * already separates a thin review from a quick one on a small diff, which is
 * the instrument the turn count was standing in for while there wasn't one;
 * nothing sampled here gave a better one to replace it with, so it is gone
 * rather than kept at a threshold that would rarely fire.
 */
export function decideSecurityOutcome({ executionText, conclusion, failAt = 'HIGH' } = {}) {
  const failures = [];
  const warnings = [];

  const { result, turns, denials, isError, finalText } = runFacts(executionText);
  if (result === null) return { ...didNotRun(), verdict: null };

  const verdict = verdictOf(finalText);

  if (conclusion !== undefined && conclusion !== 'success') {
    failures.push(`The review step reported conclusion='${conclusion}'.`);
  }
  if (isError) {
    failures.push('The review session ended with is_error=true.');
  }

  if (turns === 0) {
    // Distinguished from "gave no verdict" because the two have nothing in
    // common except being red, and saying the wrong one costs an investigation.
    // A session that took no turn never reached the model at all: the usual
    // cause is a shell command embedded in a slash command's own prompt
    // template failing during expansion, which aborts the run while the action
    // still reports conclusion=success. /security-review expands
    // `git log --no-decorate origin/HEAD...`, and a checkout without an
    // origin/HEAD ref fails it - see the step that sets one in
    // claude-security-review.yml.
    failures.push(
      'The review session ended without taking a single turn, so the prompt never reached the model ' +
        'and nothing was reviewed. This is not a verdict problem: look for a failure while the prompt ' +
        'was being expanded, which the action reports as success.',
    );
  } else if (verdict === null) {
    failures.push(
      'The review ended without a verdict line, so it never reached a verdict. ' +
        'Every run is required to end with SECURITY-VERDICT: followed by one of ' +
        `${SEVERITIES.join(', ')}.`,
    );
    // Only worth naming here. With a verdict in hand the denials are a warning
    // below, because a review that reached an answer despite a withheld tool
    // has still reviewed - and failing those runs teaches everyone to ignore
    // this check.
    if (denials.count > 0) failures.push(denialNote(denials, { reachedVerdict: false }));
  } else if (verdict.ambiguous) {
    failures.push(
      `The review gave ${verdict.ambiguous.length} verdict lines (${verdict.ambiguous.join(', ')}). One run states one verdict; which of these was meant is not something this can decide.`,
    );
  } else {
    if (SEVERITIES.indexOf(verdict.severity) >= SEVERITIES.indexOf(failAt)) {
      failures.push(
        `The review found something at ${verdict.severity}, which is at or above ${failAt} and must not merge.`,
      );
    }
    if (denials.count > 0) warnings.push(denialNote(denials, { reachedVerdict: true }));
  }

  return {
    ok: failures.length === 0,
    failures,
    warnings,
    verdict: verdict && !verdict.ambiguous ? verdict.severity : null,
    turns,
    denials,
  };
}

/**
 * The head a remark can be held against - `{ sha, arrivedAt }` - or null where
 * this run cannot place one in time.
 *
 * `arrivedAt` is the earliest of the dates in `runCreatedDates`, one per line,
 * which the caller reads off the workflow runs GitHub has created for this
 * commit as a head. So it is **when GitHub first saw the push**, on GitHub's own
 * clock, and the reviewer cannot have said anything about this head before it.
 *
 * The commit's own committer date is the obvious source and the wrong one,
 * because it is written by whatever clock made the commit and bounds nothing:
 *
 * - **Dated early**, which needs no bad actor - commit at 09:45, let a review
 *   post at 10:00 against the head you had pushed, then push this one at 15:00
 *   - and every remark from that earlier round post-dates the head and counts
 *   as being about it. The gate reverts to what issue 75 is about, silently,
 *   because it believes it placed the head.
 * - **Dated late**, by a clock running fast, and the head arrives after every
 *   remark the review could possibly have left - the summary comment included,
 *   which is the only thing a review that found nothing leaves behind. A
 *   thorough review then reads as never having looked, and going red at one is
 *   how everybody learns to ignore this check.
 *
 * A run's creation is immune to both, and to a re-run: `created_at` stays at
 * the original attempt's while `run_started_at` moves, which is why the caller
 * asks for that field. Taking the earliest rather than this run's own is what
 * lets a re-run against an already-reviewed head still find its own round's
 * remarks on the right side of the line.
 *
 * Nothing to place against - no SHA, or no run date this can read - falls back
 * to the pull request as a whole with a warning, rather than going red at
 * GitHub for being unreachable: louder than the bug it guards against, and
 * about the wrong thing. Deciding that here, once, is what keeps the count and
 * the decision that reads it answering for the same head.
 */
export function placeHead(sha, runCreatedDates) {
  let arrivedAt = null;
  for (const line of String(runCreatedDates ?? '').split('\n')) {
    const created = Date.parse(line.trim());
    if (Number.isFinite(created) && (arrivedAt === null || created < arrivedAt)) arrivedAt = created;
  }
  return sha && arrivedAt !== null ? { sha: String(sha), arrivedAt } : null;
}

/**
 * What the reviewer has said here, in total and about the head being reviewed
 * now: `{ total, onHead }`.
 *
 * The total on its own was the whole test until "The review check goes green
 * when the reviewer declined to look at the new commits" (issue 75). It holds
 * for the first round and cannot hold after one, because round one's comments
 * satisfy it permanently - so from round two on it could not tell "reviewed,
 * found nothing" from "declined without looking", and pull request 193 went
 * green on its fourth head having read none of it.
 *
 * A remark counts as being about this head when it names the commit or
 * post-dates it:
 *
 * - The commit is `originalCommitId` on an inline finding and `commitId` on a
 *   submitted review. Original rather than current, because GitHub rewrites an
 *   inline comment's `commitId` to the new head whenever the comment still
 *   applies there - matching that would hand every stale finding a head it
 *   never saw.
 * - Otherwise the timestamp, which is all a summary comment has: it is an issue
 *   comment and carries no commit at all, and it is what a review that found
 *   nothing leaves behind.
 *
 * `head` is a placed head from placeHead, so `arrivedAt` is when GitHub first
 * saw the push - which is the moment before which no remark here can be about
 * this head, and after which one may be.
 *
 * The login is matched by prefix, case-insensitively, because the same account
 * appears under more than one name: `claude[bot]` on the App's own comments,
 * `claude` on others. Loosening it further is how somebody named `claude-fan`
 * comes to count as the reviewer having spoken.
 *
 * One JSON object per line, read by jsonLines above, which documents why the
 * output is asked for in that shape.
 */
export function reviewerRemarks(ghOutput, { head = null, prefix = 'claude' } = {}) {
  const wanted = prefix.toLowerCase();
  let total = 0;
  let onHead = 0;

  for (const remark of jsonLines(ghOutput)) {
    if (!String(remark?.login ?? '').trim().toLowerCase().startsWith(wanted)) continue;
    total += 1;

    const commit = remark.originalCommitId ?? remark.commitId ?? null;
    const saidAt = Date.parse(remark.createdAt ?? '');
    const namesHead = Boolean(head?.sha) && commit === head.sha;
    const postDatesHead = Number.isFinite(head?.arrivedAt) && Number.isFinite(saidAt) && saidAt >= head.arrivedAt;
    if (namesHead || postDatesHead) onHead += 1;
  }

  return { total, onHead };
}

/**
 * Whether this pull request is one the code review was obliged to speak on.
 *
 * Exported because the script has to know before the gate does: it decides
 * whether to spend four paginated `gh api` calls, one placing the head and
 * three counting what the reviewer said. Deciding it there as well would put
 * the rule in an untested copy beside
 * the tested one, which is the split "Give the code review the tested gate the
 * security review already uses" (issue 277) exists to remove.
 *
 * `pullRequest` is `{ state, isDraft }` as `gh pr view` reports them, or null
 * when GitHub could not be asked. Anything but an open non-draft skips the
 * posted-comment test rather than failing it: a review is entitled to say
 * nothing on a pull request that closed while it was running, and a gate that
 * went red for that would be red about the run rather than about the code.
 */
export function postedCommentTestApplies(pullRequest) {
  return pullRequest?.state === 'OPEN' && pullRequest?.isDraft === false;
}

/**
 * Whether the code review's check goes green.
 *
 * The same record as decideSecurityOutcome reads, asked a different question.
 * There is no verdict line here: `/code-review --comment` posts inline comments
 * when it has findings and a summary comment when it has none, so *having
 * posted* is what separates a review from a non-review.
 *
 * Posted **about the head this run was given**, which is `saidOnHead` out of
 * the `said` remarks the reviewer has left here in total - see reviewerRemarks
 * for how one is told from the other. Asking about the pull request as a whole
 * was the bug in "The review check goes green when the reviewer declined to
 * look at the new commits" (issue 75): round one's comments answer it for good,
 * so every later round could decline in silence and stay green.
 *
 * The command's four stop conditions are the deliberate exceptions, and each is
 * accounted for: closed and draft never reach the test, because `pullRequest`
 * excludes them below; "already reviewed" is now a condition about the head,
 * instructed as such by the workflow's appended system prompt, so a genuine
 * re-run declines against a head it has already spoken on and still passes;
 * and the trivial-change stop is instructed away by the same prompt, which
 * requires that verdict to be posted like any other. Run 33407302266 is why
 * that instruction exists - it took the trivial stop on pull request 80 and
 * failed this gate for a review that had reached the right answer.
 *
 * `pullRequest` is what postedCommentTestApplies above reads. `head` is a placed
 * head from placeHead, or null where this run could not place one.
 */
export function decideCodeReviewOutcome({ executionText, conclusion, said = 0, saidOnHead = 0, head = null, pullRequest = null, minTurns = 10 } = {}) {
  const failures = [];
  const warnings = [];

  const { result, turns, denials, subtype, isError, finalText } = runFacts(executionText);
  if (result === null) {
    return { ...didNotRun(), subtype: 'unknown', isError: false, finalText: '', said: 0, saidOnHead: 0, headKnown: false, verdictSeen: false };
  }

  if (conclusion !== undefined && conclusion !== 'success') {
    failures.push(`The review step reported conclusion='${conclusion}'.`);
  }
  if (isError) {
    failures.push('The review session ended with is_error=true.');
  }
  // Not something decideSecurityOutcome asks, and left that way on purpose:
  // moving this gate was meant to change where the decision lives, not what
  // either check decides.
  if (subtype !== 'success') {
    failures.push(`The review session ended with subtype='${oneLine(subtype)}'.`);
  }

  const applies = postedCommentTestApplies(pullRequest);
  // Placed by placeHead, which is where the two ways of failing to place a head
  // are decided - and decided once, so this and the count it reads answer for
  // the same commit. Unplaced, there is no head test to make, so the check
  // falls back to the pull request as a whole rather than going red at a clock
  // or at an unreachable GitHub: louder than the bug it guards against, and
  // about the wrong thing.
  const headKnown = Boolean(head?.sha);
  const spoke = headKnown ? saidOnHead : said;
  const verdictSeen = applies && spoke > 0;

  if (applies && !headKnown) {
    warnings.push(
      'Could not place this run\'s head in time, so the check only asked whether the reviewer has ever ' +
        'spoken here. An earlier round answers that, so a decline against the current head would have passed.',
    );
  }

  if (applies && spoke === 0) {
    failures.push(
      headKnown && said > 0
        ? `The review posted nothing about ${String(head.sha).slice(0, 7)}, the head it was run against, though the reviewer has ${said} earlier remark(s) here. Those answer earlier heads; commits nobody has read are not reviewed by them.`
        : 'The review posted nothing on this pull request. A review that reaches a verdict always says so, ' +
          'so this one did not reach one.',
    );
    if (denials.count > 0) failures.push(denialNote(denials, { reachedVerdict: false }));
  } else if (verdictSeen && denials.count > 0) {
    warnings.push(denialNote(denials, { reachedVerdict: true }));
  }

  // Never a failure, and now never more than a note either. It was carrying the
  // decline case - run 33203441279 stopped after 5 clean turns because the
  // review had run on this pull request before - in a warning nobody's
  // automation reads; the head test above fails that run outright, which is
  // what "The review check goes green when the reviewer declined to look at the
  // new commits" (issue 75) asked for. What is left is too weak to catch a
  // non-review on its own: run 33201638348 spent 11 turns and stopped with
  // "Waiting on the eligibility check for PR #56 before proceeding".
  if (turns < minTurns) {
    warnings.push(`The session ran only ${turns} turns. Its closing words: ${oneLine(finalText)}`);
  }

  return { ok: failures.length === 0, failures, warnings, turns, denials, subtype, isError, finalText, said, saidOnHead, headKnown, verdictSeen };
}
