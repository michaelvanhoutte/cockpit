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
// The code review's half of this arrived with "Give the code review the tested
// gate the security review already uses" (issue 277), which moved that gate out
// of the workflow. Those cases are here rather than in a file of their own
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
  denialsOf,
  markedCommentId,
  oneLine,
  placeHead,
  postedCommentTestApplies,
  resultRecordOf,
  reviewerRemarks,
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

describe('denialsOf', () => {
  it('collects each denial\'s own message, not just its tool name', () => {
    // The two shapes sampled across issue 284's pull requests: a compound
    // command naming the sub-command that needed approval, and an output
    // redirection refused outright regardless of the allowlist.
    const execution = [
      { type: 'system', subtype: 'permission_denied', tool_name: 'Bash', message: 'The following part requires approval: grep -n "sql" a.ts b.ts' },
      { type: 'system', subtype: 'permission_denied', tool_name: 'Bash', message: "Output redirection to '/tmp/pr.diff' was blocked." },
    ];
    const denials = denialsOf(execution, {});
    assert.deepEqual(denials.messages, [
      'The following part requires approval: grep -n "sql" a.ts b.ts',
      "Output redirection to '/tmp/pr.diff' was blocked.",
    ]);
  });

  it('deduplicates identical messages', () => {
    const execution = [
      { type: 'system', subtype: 'permission_denied', tool_name: 'Bash', message: 'Output redirection was blocked.' },
      { type: 'system', subtype: 'permission_denied', tool_name: 'Bash', message: 'Output redirection was blocked.' },
    ];
    assert.deepEqual(denialsOf(execution, {}).messages, ['Output redirection was blocked.']);
  });

  it('is an empty list of messages for a denial with none, rather than a hole in the array', () => {
    const execution = [{ type: 'system', subtype: 'permission_denied', tool_name: 'Bash(node)' }];
    assert.deepEqual(denialsOf(execution, {}).messages, []);
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

  it('gives no warning for a short, clean session with no denials', () => {
    // "Make the security review warning mean something, or drop it" (issue
    // 284): seven of eight pull requests sampled carried a turn-count warning
    // under a NONE verdict, most 4 to 9 turns, and the count tracked nothing
    // about the diff. The verdict already separates a thin review from a
    // quick one, so a clean verdict with no denials warns about nothing at
    // all - however few turns it took.
    const out = decideSecurityOutcome({ executionText: file(run({ turns: 3 })), conclusion: 'success' });
    assert.equal(out.ok, true);
    assert.deepEqual(out.warnings, []);
    assert.equal(out.turns, 3);
  });

  it('warns with the denial\'s own message, not just the tool name it repeats', () => {
    // "Bash, Bash, Bash" was the actual warning on pull request 266: every
    // denial there named the same tool and nothing else. The message on each
    // one said what a reader could act on - here, that a command was refused
    // for redirecting its output to a file.
    const execution = [
      {
        type: 'system',
        subtype: 'permission_denied',
        tool_name: 'Bash',
        message: "Output redirection to '/tmp/pr266.diff' was blocked. For security, Claude Code may only write to files in the allowed working directories for this session.",
      },
      run(),
    ];
    const out = decideSecurityOutcome({ executionText: file(execution), conclusion: 'success' });
    assert.equal(out.ok, true);
    assert.match(out.warnings.join(' '), /Output redirection/);
    assert.doesNotMatch(out.warnings.join(' '), /\(Bash\)/);
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
    const execution = [{ type: 'system', subtype: 'permission_denied', tool_name: 'Bash(node)' }, run()];
    const body = summaryComment(decideSecurityOutcome({ executionText: file(execution), conclusion: 'success' }));
    assert.match(body, /Verdict: NONE/);
    assert.match(body, /tool call\(s\) were denied/);
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

/** The commit under review as placeHead hands it on, and a clock either side. */
const HEAD = { sha: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0', arrivedAt: Date.parse('2026-09-09T12:00:00Z') };
const BEFORE_HEAD = '2026-09-09T11:00:00Z';
const AFTER_HEAD = '2026-09-09T12:30:00Z';
const EARLIER_HEAD = '0f0e0d0c0b0a09080706050403020100f0e0d0c0';

describe('placeHead', () => {
  it('places the head at the earliest run GitHub created for it', () => {
    // The listing comes back newest first, so the earliest is last - and it is
    // the push. A later run is a re-run, or another workflow starting behind
    // the first.
    const created = ['2026-09-09T12:36:47Z', '2026-09-09T12:00:00Z', '2026-09-09T12:00:04Z'].join('\n');
    assert.deepEqual(placeHead(HEAD.sha, created), HEAD);
  });

  it('places nothing without a head, and nothing without a run to date it by', () => {
    // Both mean the same thing to the gate - fall back to the pull request as a
    // whole - and neither is a reason to call a review a non-review.
    assert.equal(placeHead('', '2026-09-09T12:00:00Z'), null);
    assert.equal(placeHead(undefined, '2026-09-09T12:00:00Z'), null);
    for (const dates of ['', null, undefined, '\n  \n']) {
      assert.equal(placeHead(HEAD.sha, dates), null, `${JSON.stringify(dates)} should place nothing`);
    }
  });

  it('reads past a line that is not a date', () => {
    // What a `gh api` failure or a changed field name leaves in the output. One
    // unreadable line is not a reason to abandon the dates either side of it.
    assert.deepEqual(placeHead(HEAD.sha, ['null', '2026-09-09T12:00:00Z', 'not a date'].join('\n')), HEAD);
  });

  it('places nothing when no line is a date at all', () => {
    assert.equal(placeHead(HEAD.sha, ['null', 'not a date'].join('\n')), null);
  });
});

describe('reviewerRemarks', () => {
  /** One line of `gh api --paginate --jq` output, as the script emits them. */
  const remark = (fields = {}) => JSON.stringify({ login: 'claude[bot]', createdAt: AFTER_HEAD, ...fields });
  const lines = (...remarks) => remarks.join('\n');

  it('counts the reviewer under both names it comments as', () => {
    // The App posts as claude[bot]; the same account appears as claude
    // elsewhere. Missing either reads a review that spoke as one that did not.
    const output = lines(remark(), remark({ login: 'someone' }), remark({ login: 'Claude' }));
    assert.deepEqual(reviewerRemarks(output, { head: HEAD }), { total: 2, onHead: 2 });
  });

  it('does not count a login that merely contains the name', () => {
    // Anyone can pick a username. Counting `notclaude` would let a comment from
    // a stranger stand in for the review having happened.
    const output = lines(remark({ login: 'notclaude' }), remark({ login: 'un-claude' }), remark({ login: 'michaelvanhoutte' }));
    assert.deepEqual(reviewerRemarks(output, { head: HEAD }), { total: 0, onHead: 0 });
  });

  it('does not read an earlier round as a remark about this head', () => {
    // The bug itself: three rounds of findings on pull request 193 satisfied
    // "has Claude spoken here" permanently, so the fourth head went green
    // having been read by nobody.
    const output = lines(remark({ createdAt: BEFORE_HEAD }), remark({ createdAt: BEFORE_HEAD, commitId: EARLIER_HEAD }));
    assert.deepEqual(reviewerRemarks(output, { head: HEAD }), { total: 2, onHead: 0 });
  });

  it('reads a summary comment as being about the head when it post-dates it', () => {
    // What a review that found nothing leaves behind: an issue comment, with no
    // commit on it at all. The timestamp is the only thing that can place it.
    assert.deepEqual(reviewerRemarks(remark({ createdAt: AFTER_HEAD }), { head: HEAD }), { total: 1, onHead: 1 });
  });

  it('takes an inline finding by the commit it was made on, not the one it was moved to', () => {
    // GitHub rewrites a review comment's commit_id to the new head whenever the
    // comment still applies there, so matching that would hand every stale
    // finding a head it never saw. original_commit_id is the one that holds.
    const moved = remark({ createdAt: BEFORE_HEAD, commitId: HEAD.sha, originalCommitId: EARLIER_HEAD });
    assert.deepEqual(reviewerRemarks(moved, { head: HEAD }), { total: 1, onHead: 0 });
  });

  it('counts a submitted review against the commit it names', () => {
    // A review carries commit_id and no original, and it is the commit
    // reviewed. Its timestamp arrives as submitted_at, which the script maps
    // onto createdAt - a review read without that reads as never made.
    const early = remark({ createdAt: BEFORE_HEAD, commitId: HEAD.sha });
    assert.deepEqual(reviewerRemarks(early, { head: HEAD }), { total: 1, onHead: 1 });
  });

  it('reads across pages and past a line it cannot parse', () => {
    // `gh api --paginate` applies --jq per page and concatenates, so this
    // arrives as one object per line rather than as one document.
    assert.deepEqual(reviewerRemarks(lines(remark(), 'not json at all', remark()), { head: HEAD }), { total: 2, onHead: 2 });
  });

  it('is silence for no output at all', () => {
    // What a failed `gh api` leaves behind, and it has to read as silence: a
    // gate that cannot see whether the review spoke has not established that
    // it did.
    for (const output of ['', null, undefined]) {
      assert.deepEqual(reviewerRemarks(output, { head: HEAD }), { total: 0, onHead: 0 });
    }
  });

  it('places nothing on a head it was not given', () => {
    // The caller falls back to the total when the head is unplaced, so this
    // must not guess: an unplaceable remark is not evidence about any head.
    assert.deepEqual(reviewerRemarks(remark(), {}), { total: 1, onHead: 0 });
  });

  it('places nothing by a timestamp it cannot read', () => {
    // A remark with neither created_at nor submitted_at, which is what an
    // endpoint growing a third shape would look like. Counted as the
    // reviewer's, placed nowhere - it cannot vouch for a head it has no time
    // for, and the commit is the only other thing that can.
    for (const createdAt of [null, undefined, 'whenever']) {
      assert.deepEqual(reviewerRemarks(remark({ createdAt }), { head: HEAD }), { total: 1, onHead: 0 });
    }
  });
});

describe('oneLine', () => {
  it('folds a multi-line closing message into one line', () => {
    // An annotation stops at the first newline, so without this the closing
    // words the warning exists to show are cut off — and every real closing
    // message is multi-line.
    assert.equal(oneLine('Reviewed the diff.\n\nTwo findings.\r\nBoth posted.'), 'Reviewed the diff. Two findings. Both posted.');
  });

  it('defuses a line the runner would read as a workflow command', () => {
    // The text is the model's own output. `::stop-commands::` silences every
    // annotation after it, which would take the gate's own reasons with it.
    assert.doesNotMatch(oneLine('Done.\n::stop-commands::abc'), /::/);
  });

  it('is an empty string for nothing at all', () => {
    assert.equal(oneLine(undefined), '');
    assert.equal(oneLine(null), '');
  });
});

describe('postedCommentTestApplies', () => {
  it('applies to an open pull request that is not a draft', () => {
    assert.equal(postedCommentTestApplies({ state: 'OPEN', isDraft: false }), true);
  });

  it('does not apply where the review is entitled to stay silent', () => {
    // Closed, merged, turned back into a draft while the review ran, or a
    // GitHub the script could not ask. A gate that went red for any of them
    // would be red about the run rather than about the code.
    for (const pullRequest of [{ state: 'CLOSED', isDraft: false }, { state: 'MERGED', isDraft: false }, { state: 'OPEN', isDraft: true }, null, undefined, {}]) {
      assert.equal(postedCommentTestApplies(pullRequest), false, `${JSON.stringify(pullRequest)} should not be tested`);
    }
  });
});

describe('decideCodeReviewOutcome', () => {
  /** An open pull request, which is the only state the gate tests. */
  const open = { state: 'OPEN', isDraft: false };
  // `said` is everything the reviewer has ever said here and `saidOnHead` the
  // part of it about the commit under review, so a case that gives one value
  // means "it spoke, and about this head" - which is what every case predating
  // the head test meant.
  const codeReview = ({ said = 0, saidOnHead = said, ...opts } = {}) =>
    decideCodeReviewOutcome({ conclusion: 'success', pullRequest: open, head: HEAD, said, saidOnHead, ...opts });

  it('passes a first review on a pull request the reviewer has never spoken on', () => {
    const out = codeReview({ executionText: file(run({ text: 'Reviewed, two findings posted.' })), said: 2 });
    assert.equal(out.ok, true);
    assert.equal(out.verdictSeen, true);
  });

  it('passes a review of the commits that arrived after a round of findings', () => {
    // The round that used to be skipped: six of the reviewer's comments here
    // are round one's, and the two new ones are what make this head reviewed.
    const out = codeReview({ executionText: file(run({ text: 'Two findings on the new commits.' })), said: 8, saidOnHead: 2 });
    assert.equal(out.ok, true);
  });

  it('passes a new head the reviewer looked at and found nothing wrong with', () => {
    // One remark, and it is the summary comment saying so. Nothing about a
    // clean verdict may read as a non-review.
    const out = codeReview({ executionText: file(run({ turns: 12, text: 'No issues found.' })), said: 7, saidOnHead: 1 });
    assert.equal(out.ok, true);
    assert.equal(out.warnings.length, 0);
  });

  it('passes a re-run declining a head it has already spoken on', () => {
    // Run 33203441279's shape, and the one decline that is correct: the head
    // has not moved since the reviewer posted about it, so there is nothing
    // here it has not read.
    const out = codeReview({ executionText: file(run({ turns: 4, text: 'Already reviewed this head.' })), said: 6, saidOnHead: 6 });
    assert.equal(out.ok, true);
    assert.match(out.warnings.join(' '), /ran only 4 turns/);
  });

  it('fails a decline against a head the reviewer has not spoken on, and names it', () => {
    // The bug: pull request 193's fourth head, 7 turns, green, read by nobody,
    // with three rounds of standing comments answering the heads before it.
    const out = codeReview({
      executionText: file(run({ turns: 7, text: 'Already reviewed across three rounds, so stopping here.' })),
      said: 9,
      saidOnHead: 0,
    });
    assert.equal(out.ok, false);
    assert.equal(out.verdictSeen, false);
    assert.match(out.failures.join(' '), /posted nothing about a1b2c3d/);
    assert.match(out.failures.join(' '), /the reviewer has 9 earlier remark\(s\) here/);
  });

  it('falls back to the whole pull request, loudly, when the head could not be established', () => {
    // An unreachable GitHub, or a clock that dated the head after the review
    // that read it (see placeHead), is not a reason to call every review a
    // non-review: that would be redder, and about the wrong thing. It is a
    // reason to say the check proved less than usual.
    for (const head of [null, undefined, {}]) {
      const out = codeReview({ executionText: file(run({ turns: 11 })), said: 3, saidOnHead: 0, head });
      assert.equal(out.ok, true, `${JSON.stringify(head)} should not fail the check`);
      assert.match(out.warnings.join(' '), /Could not place this run's head in time/);
    }
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

  it('says no more about a short session than that it was short', () => {
    // The warning used to guess at a decline whenever the reviewer had spoken
    // here before, which is the case the head test now fails outright. What is
    // left is too weak to catch a non-review on its own - run 33201638348 spent
    // 11 turns stopping on "Waiting on the eligibility check for PR #56".
    const out = codeReview({ executionText: file(run({ turns: 2, text: 'Stopped.' })), said: 6, saidOnHead: 6 });
    assert.deepEqual(out.warnings, ['The session ran only 2 turns. Its closing words: Stopped.']);
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

  it('keeps the closing words to one line in the warning that quotes them', () => {
    // The warning becomes a ::warning:: annotation, which stops at the first
    // newline and executes a line beginning `::` rather than printing it.
    const out = codeReview({ executionText: file(run({ turns: 4, text: 'Stopped.\n::stop-commands::x' })), said: 0 });
    const warning = out.warnings.join(' ');
    assert.doesNotMatch(warning, /\n|::/);
    assert.match(warning, /Stopped\./);
  });

  it('reports what the run said, so the step summary need not re-read the record', () => {
    const out = codeReview({ executionText: file(run({ turns: 11, text: 'Four findings posted.' })), said: 9, saidOnHead: 4 });
    assert.deepEqual(
      { subtype: out.subtype, isError: out.isError, turns: out.turns, finalText: out.finalText, said: out.said, saidOnHead: out.saidOnHead, headKnown: out.headKnown },
      { subtype: 'success', isError: false, turns: 11, finalText: 'Four findings posted.', said: 9, saidOnHead: 4, headKnown: true },
    );
  });
});
