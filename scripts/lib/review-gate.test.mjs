//
// Unit tests for both reviews' gates, run by `node --test` from the
// Scripts CI job — the same place scripts/lib/processes.test.mjs and
// the other scripts/lib tests are asserted, and for the same reason: this is tooling
// logic outside any package, and a silent change in it turns a check that is
// supposed to block a merge into one that always agrees.
//
// Every fixture here is a fabricated execution record. Nothing in this file
// runs Claude, contains a vulnerability, or asserts anything about whether a
// review finds real problems — that is a language model's judgement and is not
// testable. What is testable is whether the gate reads what came back
// correctly, and every incident recorded in claude-code-review.yml's comments
// was a bug at exactly that level.
//
// The code review's half of this arrived with issue 277, which moved that gate
// out of the workflow. Those cases are here rather than in a file of their own
// because the two gates read one record through one set of helpers, and a
// change to the denial counting has to be answerable for both.
//

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  COMMENT_MARKER,
  GATE_AUTHOR,
  decideCodeReviewOutcome,
  decideSecurityOutcome,
  markedCommentId,
  resultRecordOf,
  reviewerCommentCount,
  summaryComment,
  verdictOf,
} from './review-gate.mjs';

/** A result record as the action writes one, with the parts under test. */
function run({ text = 'SECURITY-VERDICT: NONE', turns = 14, ...rest } = {}) {
  return { type: 'result', subtype: 'success', is_error: false, num_turns: turns, result: text, ...rest };
}

/** What the workflow hands the gate: the file's raw text. */
function file(value) {
  return JSON.stringify(value);
}

describe('verdictOf', () => {
  it('reads the severity off the verdict line', () => {
    assert.deepEqual(verdictOf('Reviewed the diff.\nSECURITY-VERDICT: MEDIUM'), { severity: 'MEDIUM' });
  });

  it('ignores severity words in the findings prose', () => {
    const text = 'No critical or high severity issues found in the ingress route.\nSECURITY-VERDICT: NONE';
    assert.deepEqual(verdictOf(text), { severity: 'NONE' });
  });

  it('is null when the run never gave a verdict', () => {
    assert.equal(verdictOf('Looks fine to me.'), null);
  });

  it('is null for a severity it does not know', () => {
    assert.equal(verdictOf('SECURITY-VERDICT: PROBABLY-FINE'), null);
  });

  it('reports every verdict when a run gave more than one, rather than picking', () => {
    // The likely shape: the reviewer restates the required format on its own
    // line, then uses it. Both are line-anchored, so both match, and choosing
    // between them would be inventing an answer nobody gave.
    const text = 'The format I was asked for:\nSECURITY-VERDICT: HIGH\n\nMy verdict:\nSECURITY-VERDICT: NONE';
    assert.deepEqual(verdictOf(text), { ambiguous: ['HIGH', 'NONE'] });
  });

  it('does not match a verdict quoted mid-sentence', () => {
    assert.equal(verdictOf('I was asked to end with SECURITY-VERDICT: HIGH but found nothing.'), null);
  });

  it('reads a verdict whose label is cased differently', () => {
    // Every way this fails to match costs the same thing: a run that did
    // review reads as one that never reached a verdict.
    assert.deepEqual(verdictOf('Security-Verdict: high'), { severity: 'HIGH' });
  });

  it('reads a verdict line terminated with CRLF', () => {
    // Passes without any \r handling in the pattern, because ECMAScript counts
    // \r as a line terminator of its own and `$` under `m` matches before it.
    // Kept because a review asked for a \r? tolerance on the assumption that it
    // does not — this is where that question gets answered next time.
    assert.deepEqual(verdictOf('Reviewed.\r\nSECURITY-VERDICT: MEDIUM\r\n'), { severity: 'MEDIUM' });
  });
});

describe('resultRecordOf', () => {
  it('takes the last result from a stream of messages', () => {
    const execution = [{ type: 'system' }, run({ text: 'first' }), run({ text: 'last' })];
    assert.equal(resultRecordOf(execution).result, 'last');
  });

  it('reads a lone result object directly', () => {
    assert.equal(resultRecordOf(run({ text: 'only' })).result, 'only');
  });

  it('is null when a stream carries no result at all', () => {
    assert.equal(resultRecordOf([{ type: 'system' }, { type: 'assistant' }]), null);
  });
});

describe('decideSecurityOutcome', () => {
  it('passes a run that found nothing', () => {
    const out = decideSecurityOutcome({ executionText: file(run()), conclusion: 'success' });
    assert.equal(out.ok, true);
    assert.equal(out.verdict, 'NONE');
  });

  it('passes a run that found something below the failing severity', () => {
    for (const severity of ['LOW', 'MEDIUM']) {
      const out = decideSecurityOutcome({
        executionText: file(run({ text: `SECURITY-VERDICT: ${severity}` })),
        conclusion: 'success',
      });
      assert.equal(out.ok, true, `${severity} should not fail the check`);
      assert.equal(out.verdict, severity);
    }
  });

  it('fails a run that found something at the failing severity', () => {
    const out = decideSecurityOutcome({ executionText: file(run({ text: 'SECURITY-VERDICT: HIGH' })), conclusion: 'success' });
    assert.equal(out.ok, false);
    assert.match(out.failures.join(' '), /HIGH/);
  });

  it('says the session never started when it took no turns, rather than blaming the verdict', () => {
    // The shape every run took between this workflow merging and the
    // origin/HEAD step being added: the action reports success, the record
    // carries no error, and nothing was reviewed because the prompt never
    // reached the model. Reported as a missing verdict it sends the reader
    // looking at the reviewer's output, of which there is none.
    const out = decideSecurityOutcome({ executionText: file(run({ turns: 0, text: '' })), conclusion: 'success' });
    assert.equal(out.ok, false);
    assert.match(out.failures.join(' '), /without taking a single turn/);
    assert.doesNotMatch(out.failures.join(' '), /verdict line/);
  });

  it('fails a run that never gave a verdict', () => {
    const out = decideSecurityOutcome({ executionText: file(run({ text: 'Nothing to add.' })), conclusion: 'success' });
    assert.equal(out.ok, false);
    assert.match(out.failures.join(' '), /never reached a verdict/);
  });

  it('fails a run that gave two verdicts rather than choosing one', () => {
    const text = 'SECURITY-VERDICT: HIGH\nand also\nSECURITY-VERDICT: NONE';
    const out = decideSecurityOutcome({ executionText: file(run({ text })), conclusion: 'success' });
    assert.equal(out.ok, false);
    assert.match(out.failures.join(' '), /two verdict lines|2 verdict lines/);
  });

  it('names the denied tools when a blocked run reached no verdict', () => {
    const execution = [
      { type: 'system', subtype: 'permission_denied', tool_name: 'Bash(gh pr diff)' },
      run({ text: 'I could not read the diff.' }),
    ];
    const out = decideSecurityOutcome({ executionText: file(execution), conclusion: 'success' });
    assert.equal(out.ok, false);
    assert.match(out.failures.join(' '), /Bash\(gh pr diff\)/);
  });

  it('passes a run that reached a verdict despite a denied tool, with a warning', () => {
    const execution = [{ type: 'system', subtype: 'permission_denied', tool_name: 'Bash(node)' }, run()];
    const out = decideSecurityOutcome({ executionText: file(execution), conclusion: 'success' });
    assert.equal(out.ok, true);
    assert.match(out.warnings.join(' '), /Bash\(node\)/);
  });

  it('counts denials from the message stream when the summary omits the field', () => {
    const execution = [
      { type: 'system', subtype: 'permission_denied', tool_name: 'Bash(git log)' },
      { type: 'system', subtype: 'permission_denied', tool_name: 'Read' },
      run({ text: 'Blocked.' }), // no permission_denials_count at all
    ];
    const out = decideSecurityOutcome({ executionText: file(execution), conclusion: 'success' });
    assert.equal(out.denials.count, 2);
  });

  it('counts only the denials among the system messages, not every system message', () => {
    // Without this fixture, loosening denialsOf's subtype check to count any
    // system-typed message would pass the whole suite: every other denial
    // fixture contains denials and nothing else, so the filter is never asked
    // to reject anything.
    const execution = [
      { type: 'system', subtype: 'init' },
      { type: 'system', subtype: 'permission_denied', tool_name: 'Read' },
      { type: 'system', subtype: 'turn_started' },
      run(),
    ];
    assert.equal(decideSecurityOutcome({ executionText: file(execution), conclusion: 'success' }).denials.count, 1);
  });

  it('trusts whichever denial count is higher when the two disagree', () => {
    const execution = [
      { type: 'system', subtype: 'permission_denied', tool_name: 'Read' },
      run({ permission_denials_count: 5 }),
    ];
    assert.equal(decideSecurityOutcome({ executionText: file(execution), conclusion: 'success' }).denials.count, 5);
  });

  it('fails a run the action itself reported as unsuccessful', () => {
    const out = decideSecurityOutcome({ executionText: file(run()), conclusion: 'failure' });
    assert.equal(out.ok, false);
    assert.match(out.failures.join(' '), /conclusion='failure'/);
  });

  it('fails a run flagged as an error whatever its verdict says', () => {
    const out = decideSecurityOutcome({ executionText: file(run({ is_error: true })), conclusion: 'success' });
    assert.equal(out.ok, false);
    assert.match(out.failures.join(' '), /is_error/);
  });

  it('fails an empty or unparseable execution file', () => {
    for (const text of ['', 'not json at all', '[]', 'null']) {
      const out = decideSecurityOutcome({ executionText: text, conclusion: 'success' });
      assert.equal(out.ok, false, `${JSON.stringify(text)} should fail`);
      assert.match(out.failures.join(' '), /did not run/);
    }
  });

  it('warns about a short session but never fails on it', () => {
    const out = decideSecurityOutcome({ executionText: file(run({ turns: 3 })), conclusion: 'success' });
    assert.equal(out.ok, true);
    assert.match(out.warnings.join(' '), /only 3 turns/);
  });
});

describe('summaryComment', () => {
  const decide = (opts) => decideSecurityOutcome({ executionText: file(run(opts)), conclusion: 'success' });

  it('leaves the marker to upsertSticky, so it is not written twice', () => {
    // Identifying a workflow's note is one decision and it lives in one place.
    assert.doesNotMatch(summaryComment(decide()), new RegExp(COMMENT_MARKER));
  });

  it('says a clean review looked and found nothing, not merely that the check passed', () => {
    // The distinction the whole gate exists for: from the pull request alone,
    // "reviewed, found nothing" must not read the same as "never ran".
    const body = summaryComment(decide());
    assert.match(body, /Verdict: NONE/);
    assert.match(body, /reported nothing/);
    // Must not claim the whole diff was read: the gate cannot see how much was
    // covered, and saying so confidently is the failure the instructions file
    // calls the one nothing downstream can catch.
    assert.doesNotMatch(body, /read the diff and found nothing/);
    assert.match(body, /cannot tell you how much was covered/);
  });

  it('states the verdict for findings that do not block', () => {
    const body = summaryComment(decide({ text: 'SECURITY-VERDICT: MEDIUM' }));
    assert.match(body, /Verdict: MEDIUM/);
    assert.match(body, /do not block the merge/);
  });

  it('gives the reason when the check is red, rather than only the verdict', () => {
    const body = summaryComment(decide({ text: 'SECURITY-VERDICT: HIGH' }));
    assert.match(body, /This check is red/);
    assert.match(body, /must not merge/);
  });

  it('explains a red that is not a finding at all', () => {
    const body = summaryComment(decide({ turns: 0, text: '' }));
    assert.match(body, /This check is red/);
    assert.match(body, /without taking a single turn/);
    assert.doesNotMatch(body, /Verdict:/);
  });

  it('keeps warnings out of the headline', () => {
    const body = summaryComment(decide({ turns: 2 }));
    assert.match(body, /Verdict: NONE/);
    assert.match(body, /only 2 turns/);
    assert.match(body, /<details>/);
  });
});

describe('markedCommentId', () => {
  const gate = (id) => JSON.stringify({ id, login: GATE_AUTHOR, body: `${COMMENT_MARKER}\n## Security review` });
  const other = (id) => JSON.stringify({ id, login: 'someone', body: 'Looks good to me' });
  /** Someone else's comment carrying the marker. The marker is public. */
  const impostor = (id) => JSON.stringify({ id, login: 'someone', body: `${COMMENT_MARKER} not really` });

  it('finds the note the gate left', () => {
    assert.equal(markedCommentId([other(1), gate(2), other(3)].join('\n')), 2);
  });

  it('is null when there is no note yet', () => {
    assert.equal(markedCommentId([other(1), other(2)].join('\n')), null);
  });

  it('is null for empty output', () => {
    assert.equal(markedCommentId(''), null);
  });

  it('reads across pages, where the first version stopped being JSON', () => {
    // `gh api --paginate` applies --jq per page and concatenates the results.
    // The first version wrapped its filter in an array, so this arrived as
    // `[...]\n[...]` and threw — swallowed into a warning, leaving the comment
    // unposted on any pull request past thirty comments.
    assert.equal(markedCommentId([other(1), other(2), other(3), gate(4)].join('\n')), 4);
  });

  it('keeps reading past a line it cannot parse', () => {
    assert.equal(markedCommentId(['not json at all', gate(7)].join('\n')), 7);
  });

  it('ignores the marker in a comment somebody else wrote', () => {
    // The marker is a public constant and GitHub lists comments oldest first,
    // so without the author check anyone able to comment could post it before
    // the gate's first run and have every later run overwrite their comment
    // instead of writing the verdict anywhere.
    assert.equal(markedCommentId(impostor(1)), null);
  });

  it('finds its own note even when an impostor posted first', () => {
    assert.equal(markedCommentId([impostor(1), gate(2)].join('\n')), 2);
  });
});

describe('reviewerCommentCount', () => {
  it('counts the reviewer under both names it comments as', () => {
    // The App posts as claude[bot]; the same account appears as claude
    // elsewhere. Missing either reads a review that spoke as one that did not.
    assert.equal(reviewerCommentCount('claude[bot]\nsomeone\nClaude'), 2);
  });

  it('is zero when only other people have spoken', () => {
    assert.equal(reviewerCommentCount('michaelvanhoutte\ngithub-actions[bot]\n'), 0);
  });

  it('does not count a login that merely contains the name', () => {
    // Anyone can pick a username. Counting `notclaude` would let a comment from
    // a stranger stand in for the review having happened.
    assert.equal(reviewerCommentCount('notclaude\nun-claude'), 0);
  });

  it('is zero for no output at all', () => {
    // What a failed `gh api` leaves behind, and it has to read as silence:
    // a gate that cannot see whether the review spoke has not established that
    // it did.
    assert.equal(reviewerCommentCount(''), 0);
    assert.equal(reviewerCommentCount(null), 0);
  });
});

describe('decideCodeReviewOutcome', () => {
  /** An open pull request, which is the only state the gate tests. */
  const open = { state: 'OPEN', isDraft: false };
  const codeReview = (opts = {}) => decideCodeReviewOutcome({ conclusion: 'success', pullRequest: open, ...opts });

  it('passes a run the reviewer posted on', () => {
    const out = codeReview({ executionText: file(run({ text: 'Reviewed, two findings posted.' })), said: 2 });
    assert.equal(out.ok, true);
    assert.equal(out.verdictSeen, true);
  });

  it('fails a run that posted nothing at all', () => {
    // The whole point of the gate: with --comment, every path to a verdict
    // posts something, so silence means no verdict was reached.
    const out = codeReview({ executionText: file(run({ text: 'Done.' })), said: 0 });
    assert.equal(out.ok, false);
    assert.match(out.failures.join(' '), /posted nothing on this pull request/);
  });

  it('names the denied tools when a blocked run posted nothing', () => {
    const execution = [
      { type: 'system', subtype: 'permission_denied', tool_name: 'Skill' },
      run({ text: 'I could not start the review.' }),
    ];
    const out = codeReview({ executionText: file(execution), said: 0 });
    assert.equal(out.ok, false);
    assert.match(out.failures.join(' '), /Skill/);
  });

  it('passes a run that posted despite a denied tool, with a warning', () => {
    // Run 33202686222: a validation agent reached for `node -e` to execute the
    // pull request's own logic, was refused, adapted, and posted its findings.
    // Failing that run would teach everyone to ignore this check.
    const execution = [{ type: 'system', subtype: 'permission_denied', tool_name: 'Bash(node)' }, run()];
    const out = codeReview({ executionText: file(execution), said: 1 });
    assert.equal(out.ok, true);
    assert.match(out.warnings.join(' '), /Bash\(node\)/);
  });

  it('counts denials from the message stream when the summary omits the field', () => {
    // Run 33201638348 in this workflow: permission_denials_count absent while
    // the stream held a real denial, so the gate read "no denials" and the
    // blocked session went green.
    const execution = [
      { type: 'system', subtype: 'permission_denied', tool_name: 'Skill' },
      { type: 'system', subtype: 'permission_denied', tool_name: 'Bash(gh pr diff)' },
      run({ text: 'Blocked.' }),
    ];
    assert.equal(codeReview({ executionText: file(execution), said: 0 }).denials.count, 2);
  });

  it('fails a session that ended on a subtype other than success', () => {
    // The one check the security gate does not make, kept because moving this
    // gate was meant to change where the decision lives, not what it decides.
    const out = codeReview({ executionText: file(run({ subtype: 'error_max_turns' })), said: 3 });
    assert.equal(out.ok, false);
    assert.match(out.failures.join(' '), /subtype='error_max_turns'/);
  });

  it('fails a run the action itself reported as unsuccessful', () => {
    const out = codeReview({ executionText: file(run()), conclusion: 'failure', said: 1 });
    assert.equal(out.ok, false);
    assert.match(out.failures.join(' '), /conclusion='failure'/);
  });

  it('fails a run flagged as an error however much it posted', () => {
    const out = codeReview({ executionText: file(run({ is_error: true })), said: 4 });
    assert.equal(out.ok, false);
    assert.match(out.failures.join(' '), /is_error/);
  });

  it('fails an empty or unparseable execution file', () => {
    // Including the case that produced it: the action sets no outputs at all
    // when its own workflow validation refuses to run, which is every pull
    // request editing claude-code-review.yml.
    for (const text of ['', 'not json at all', '[]', 'null']) {
      const out = codeReview({ executionText: text, said: 1 });
      assert.equal(out.ok, false, `${JSON.stringify(text)} should fail`);
      assert.match(out.failures.join(' '), /did not run/);
    }
  });

  it('warns rather than fails when a short session declined a head it had already reviewed', () => {
    // Run 33203441279: 5 clean turns, stopping because the review had run on
    // this pull request before - which leaves the commits pushed since
    // unreviewed. Green today, and issue 75 owns changing that; this holds the
    // behaviour still while it is somebody else's to change.
    const out = codeReview({ executionText: file(run({ turns: 5, text: 'Already reviewed.' })), said: 6 });
    assert.equal(out.ok, true);
    assert.match(out.warnings.join(' '), /only 5 turns, and Claude has already posted/);
  });

  it('warns about a short session plainly when nothing was posted', () => {
    const out = codeReview({ executionText: file(run({ turns: 2, text: 'Stopped.' })), said: 0 });
    assert.match(out.warnings.join(' '), /ran only 2 turns\. Its closing words: Stopped\./);
    assert.doesNotMatch(out.warnings.join(' '), /already posted/);
  });

  it('skips the posted-comment test on a pull request the review may stay silent on', () => {
    // Closed, merged or turned back into a draft while the review was running.
    // A review is entitled to say nothing on any of them, and a gate that went
    // red for it would be red about the run rather than about the code.
    for (const pullRequest of [{ state: 'CLOSED', isDraft: false }, { state: 'MERGED', isDraft: false }, { state: 'OPEN', isDraft: true }, null]) {
      const out = codeReview({ executionText: file(run({ text: 'Nothing to say.' })), said: 0, pullRequest });
      assert.equal(out.ok, true, `${JSON.stringify(pullRequest)} should not fail the check`);
      assert.equal(out.verdictSeen, false);
    }
  });

  it('reports what the run said, so the step summary need not re-read the record', () => {
    const out = codeReview({ executionText: file(run({ turns: 11, text: 'Four findings posted.' })), said: 4 });
    assert.deepEqual(
      { subtype: out.subtype, isError: out.isError, turns: out.turns, finalText: out.finalText },
      { subtype: 'success', isError: false, turns: 11, finalText: 'Four findings posted.' },
    );
  });
});
