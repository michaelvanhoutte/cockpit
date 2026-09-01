//
// Whether a Claude review run actually reached a verdict, and whether that
// verdict is one that should block a merge.
//
// This lives here rather than in the workflow because the equivalent logic in
// claude-code-review.yml is a `run:` block, and every incident recorded in that
// file's comments is a bug in it: a permission_denials_count field missing from
// the result record and read as "no denials", a three-turn blocked session
// passing as clean, a seven-turn one doing the same, a result payload that is
// sometimes an array and sometimes an object. All four are decisions over a
// JSON document, all four shipped green, and none of them was covered by
// anything, because inline bash cannot be run by a test. The same logic in a
// module is asserted by node --test in the Scripts CI job, like the rest of
// scripts/lib.
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
 * Hidden marker identifying this workflow's comment, so each run edits the one
 * it left last time instead of adding another. A review that comments on every
 * push turns a long pull request into a column of near-identical notices, which
 * is its own way of not being read.
 */
export const COMMENT_MARKER = '<!-- cockpit-security-review -->';

/**
 * What the pull request should say about this run.
 *
 * The workflow posts this rather than asking the reviewer to. The prompt does
 * ask - "post a short summary comment when you find nothing" - and on the first
 * run that ever reached a verdict it did not, leaving a green check whose only
 * evidence was inside the job log. That is the state this whole gate exists to
 * refuse: from the pull request alone, "reviewed, found nothing" and "never ran"
 * looked identical.
 *
 * Asking harder would have been the obvious fix and the wrong one. The sibling
 * workflow already tried inferring a review from whether Claude spoke, and "The
 * review check goes green when the reviewer declined to look at the new
 * commits" (issue 75) is the open bug saying that inference goes stale. The
 * gate already knows the verdict; having it say so needs no cooperation from
 * anyone.
 */
export function summaryComment(outcome) {
  const lines = [COMMENT_MARKER, '## Security review', ''];

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
 * The id of the note this workflow left last time, from `gh api --paginate`
 * output, or null if there is none yet.
 *
 * Line-oriented on purpose, and this is the whole reason it is a function with
 * tests rather than two lines in the script. `--paginate` applies `--jq` to
 * each page separately and concatenates the results, so a filter that wraps its
 * output in an array emits one array per page - `[...]\n[...]` - which is not
 * JSON and throws when parsed. The first version did exactly that. It would
 * have worked on every pull request until one passed thirty comments, and then
 * failed inside the try that makes posting non-fatal: no comment, no update of
 * the stale one already there, and a warning nobody reads. A change whose only
 * purpose is making the verdict visible would have stopped doing that
 * invisibly, which is the joke it deserved to be caught for.
 *
 * One JSON object per line concatenates safely, which is the shape
 * claude-code-review.yml's own gate already uses for the same reason.
 */
export function markedCommentId(ghOutput, marker = COMMENT_MARKER) {
  for (const line of String(ghOutput ?? '').split('\n')) {
    if (line.trim() === '') continue;
    let comment;
    try {
      comment = JSON.parse(line);
    } catch {
      // One unreadable line is not a reason to abandon the rest: the id being
      // looked for may be on any of them.
      continue;
    }
    if (String(comment?.body ?? '').includes(marker)) return comment.id;
  }
  return null;
}

function verdictMeaning(severity) {
  if (severity === 'NONE') return 'The reviewer read the diff and found nothing to report.';
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
 * How many tool calls were denied, and which.
 *
 * Counted from both places and the higher one wins. The result record's
 * permission_denials_count is absent on some runs while the message stream
 * holds real denials, so trusting the summary alone reads "no denials" off a
 * missing field - which is exactly what happened on run 33201638348 in the
 * sibling workflow.
 */
export function denialsOf(execution, result) {
  const stream = Array.isArray(execution)
    ? execution.filter((m) => m && m.type === 'system' && m.subtype === 'permission_denied')
    : [];
  const fromSummary = Number(result?.permission_denials_count ?? 0) || 0;
  const count = Math.max(stream.length, fromSummary);
  const tools = stream.map((m) => m.tool_name ?? '?');
  return { count, tools };
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
 * Whether the check goes green.
 *
 * `executionText` is the raw contents of the action's execution file, parsed
 * here rather than by the caller so that "the file was empty or unparseable"
 * is a case this can be asked about instead of a crash in the workflow.
 *
 * A failure is always a statement about what is missing, never a bare exit
 * code: this text is what a person reads when the check is red, and "the
 * review produced no verdict" and "the review found something HIGH" are
 * different problems with different fixes.
 */
export function decideOutcome({ executionText, conclusion, failAt = 'HIGH', minTurns = 10 } = {}) {
  const failures = [];
  const warnings = [];

  let execution = null;
  try {
    const parsed = JSON.parse(String(executionText ?? ''));
    execution = parsed;
  } catch {
    execution = null;
  }

  const result = resultRecordOf(execution);
  if (result === null) {
    return {
      ok: false,
      failures: ['The review produced no result record, so it did not run.'],
      warnings,
      verdict: null,
      turns: 0,
      denials: { count: 0, tools: [] },
    };
  }

  const denials = denialsOf(execution, result);
  const turns = Number(result.num_turns ?? 0) || 0;
  const verdict = verdictOf(result.result);

  if (conclusion !== undefined && conclusion !== 'success') {
    failures.push(`The review step reported conclusion='${conclusion}'.`);
  }
  if (result.is_error === true) {
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
    if (denials.count > 0) {
      failures.push(
        `It was blocked by ${denials.count} permission denial(s) (${denials.tools.join(', ') || 'see log'}), which is the likely reason.`,
      );
    }
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
    if (denials.count > 0) {
      warnings.push(
        `The review reached a verdict but ${denials.count} tool call(s) were denied (${denials.tools.join(', ') || 'see log'}). Worth a look if its findings seem thin.`,
      );
    }
    // Never a failure. A short run is as likely to be a clean small diff as a
    // blocked session, and the verdict already separates those two - which is
    // the instrument the turn count was standing in for while there wasn't one.
    if (turns < minTurns) {
      warnings.push(`The session ran only ${turns} turns. Its verdict was ${verdict.severity}.`);
    }
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
