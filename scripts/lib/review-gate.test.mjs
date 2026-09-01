//
// Unit tests for the security review's gate, run by `node --test` from the
// Scripts CI job — the same place scripts/lib/processes.test.mjs and
// branch-alias.test.sh are asserted, and for the same reason: this is tooling
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

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { COMMENT_MARKER, decideOutcome, markedCommentId, resultRecordOf, summaryComment, verdictOf } from './review-gate.mjs';

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

describe('decideOutcome', () => {
  it('passes a run that found nothing', () => {
    const out = decideOutcome({ executionText: file(run()), conclusion: 'success' });
    assert.equal(out.ok, true);
    assert.equal(out.verdict, 'NONE');
  });

  it('passes a run that found something below the failing severity', () => {
    for (const severity of ['LOW', 'MEDIUM']) {
      const out = decideOutcome({
        executionText: file(run({ text: `SECURITY-VERDICT: ${severity}` })),
        conclusion: 'success',
      });
      assert.equal(out.ok, true, `${severity} should not fail the check`);
      assert.equal(out.verdict, severity);
    }
  });

  it('fails a run that found something at the failing severity', () => {
    const out = decideOutcome({ executionText: file(run({ text: 'SECURITY-VERDICT: HIGH' })), conclusion: 'success' });
    assert.equal(out.ok, false);
    assert.match(out.failures.join(' '), /HIGH/);
  });

  it('says the session never started when it took no turns, rather than blaming the verdict', () => {
    // The shape every run took between this workflow merging and the
    // origin/HEAD step being added: the action reports success, the record
    // carries no error, and nothing was reviewed because the prompt never
    // reached the model. Reported as a missing verdict it sends the reader
    // looking at the reviewer's output, of which there is none.
    const out = decideOutcome({ executionText: file(run({ turns: 0, text: '' })), conclusion: 'success' });
    assert.equal(out.ok, false);
    assert.match(out.failures.join(' '), /without taking a single turn/);
    assert.doesNotMatch(out.failures.join(' '), /verdict line/);
  });

  it('fails a run that never gave a verdict', () => {
    const out = decideOutcome({ executionText: file(run({ text: 'Nothing to add.' })), conclusion: 'success' });
    assert.equal(out.ok, false);
    assert.match(out.failures.join(' '), /never reached a verdict/);
  });

  it('fails a run that gave two verdicts rather than choosing one', () => {
    const text = 'SECURITY-VERDICT: HIGH\nand also\nSECURITY-VERDICT: NONE';
    const out = decideOutcome({ executionText: file(run({ text })), conclusion: 'success' });
    assert.equal(out.ok, false);
    assert.match(out.failures.join(' '), /two verdict lines|2 verdict lines/);
  });

  it('names the denied tools when a blocked run reached no verdict', () => {
    const execution = [
      { type: 'system', subtype: 'permission_denied', tool_name: 'Bash(gh pr diff)' },
      run({ text: 'I could not read the diff.' }),
    ];
    const out = decideOutcome({ executionText: file(execution), conclusion: 'success' });
    assert.equal(out.ok, false);
    assert.match(out.failures.join(' '), /Bash\(gh pr diff\)/);
  });

  it('passes a run that reached a verdict despite a denied tool, with a warning', () => {
    const execution = [{ type: 'system', subtype: 'permission_denied', tool_name: 'Bash(node)' }, run()];
    const out = decideOutcome({ executionText: file(execution), conclusion: 'success' });
    assert.equal(out.ok, true);
    assert.match(out.warnings.join(' '), /Bash\(node\)/);
  });

  it('counts denials from the message stream when the summary omits the field', () => {
    const execution = [
      { type: 'system', subtype: 'permission_denied', tool_name: 'Bash(git log)' },
      { type: 'system', subtype: 'permission_denied', tool_name: 'Read' },
      run({ text: 'Blocked.' }), // no permission_denials_count at all
    ];
    const out = decideOutcome({ executionText: file(execution), conclusion: 'success' });
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
    assert.equal(decideOutcome({ executionText: file(execution), conclusion: 'success' }).denials.count, 1);
  });

  it('trusts whichever denial count is higher when the two disagree', () => {
    const execution = [
      { type: 'system', subtype: 'permission_denied', tool_name: 'Read' },
      run({ permission_denials_count: 5 }),
    ];
    assert.equal(decideOutcome({ executionText: file(execution), conclusion: 'success' }).denials.count, 5);
  });

  it('fails a run the action itself reported as unsuccessful', () => {
    const out = decideOutcome({ executionText: file(run()), conclusion: 'failure' });
    assert.equal(out.ok, false);
    assert.match(out.failures.join(' '), /conclusion='failure'/);
  });

  it('fails a run flagged as an error whatever its verdict says', () => {
    const out = decideOutcome({ executionText: file(run({ is_error: true })), conclusion: 'success' });
    assert.equal(out.ok, false);
    assert.match(out.failures.join(' '), /is_error/);
  });

  it('fails an empty or unparseable execution file', () => {
    for (const text of ['', 'not json at all', '[]', 'null']) {
      const out = decideOutcome({ executionText: text, conclusion: 'success' });
      assert.equal(out.ok, false, `${JSON.stringify(text)} should fail`);
      assert.match(out.failures.join(' '), /did not run/);
    }
  });

  it('warns about a short session but never fails on it', () => {
    const out = decideOutcome({ executionText: file(run({ turns: 3 })), conclusion: 'success' });
    assert.equal(out.ok, true);
    assert.match(out.warnings.join(' '), /only 3 turns/);
  });
});

describe('summaryComment', () => {
  const decide = (opts) => decideOutcome({ executionText: file(run(opts)), conclusion: 'success' });

  it('carries the marker, so the next run edits this comment instead of adding another', () => {
    assert.ok(summaryComment(decide()).startsWith(COMMENT_MARKER));
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
  const marked = (id) => JSON.stringify({ id, body: `${COMMENT_MARKER}\n## Security review` });
  const other = (id) => JSON.stringify({ id, body: 'Looks good to me' });

  it('finds the note this workflow left', () => {
    assert.equal(markedCommentId([other(1), marked(2), other(3)].join('\n')), 2);
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
    const pages = [other(1), other(2), other(3), marked(4)].join('\n');
    assert.equal(markedCommentId(pages), 4);
  });

  it('keeps reading past a line it cannot parse', () => {
    assert.equal(markedCommentId(['not json at all', marked(7)].join('\n')), 7);
  });

  it('ignores a body that merely mentions the marker in prose', () => {
    // A quoted marker is still a match, and should be: the alternative is
    // parsing prose to decide. What must not happen is a crash on either.
    const quoting = JSON.stringify({ id: 9, body: `someone pasted ${COMMENT_MARKER} here` });
    assert.equal(markedCommentId(quoting), 9);
  });
});
