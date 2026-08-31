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
 * The single line the run is required to end with, anchored to the start of a
 * line so that prose about severities cannot match it.
 *
 * Anchoring is the whole trick. `/security-review` returns prose, and the
 * obvious gate - look for the word "critical" or "high" - passes and fails on
 * the same sentence depending on how it is phrased: "no critical or high
 * severity issues found" contains both words and means the opposite of what
 * grepping for them concludes.
 */
const VERDICT_LINE = /^[ \t]*SECURITY-VERDICT:[ \t]*([A-Za-z]+)[ \t]*$/gm;

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

  if (verdict === null) {
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
