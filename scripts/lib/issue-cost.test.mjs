import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  activeMillis,
  costOf,
  dedupedFindings,
  emptyIssueStats,
  marksFromBody,
  normaliseMarks,
  issueFromBranchName,
  phaseAt,
  projectDirsFor,
  reviewLevel,
  sanitizePath,
  summarize,
  tokensOf,
} from './issue-cost.mjs';
import { BLOCK_END, BLOCK_START } from './session-record.mjs';

describe('sanitizePath', () => {
  it('turns every path separator and colon into a dash', () => {
    assert.equal(sanitizePath('C:\\GitHub\\Cockpit'), 'C--GitHub-Cockpit');
    assert.equal(sanitizePath('C:/GitHub/Cockpit'), 'C--GitHub-Cockpit');
  });

  it('leaves letters, digits and existing dashes alone', () => {
    assert.equal(sanitizePath('angry-poitras-12220a'), 'angry-poitras-12220a');
  });
});

describe('projectDirsFor', () => {
  const allDirs = [
    'C--GitHub-Cockpit',
    'C--GitHub-Cockpit--claude-worktrees-angry-poitras-12220a',
    'C--GitHub-Cockpit2',
    'C--GitHub-CockpitOther',
    'C--GitHub-SomethingElse',
  ];

  it('matches the main checkout exactly', () => {
    assert.ok(projectDirsFor('C:/GitHub/Cockpit', allDirs).includes('C--GitHub-Cockpit'));
  });

  it('matches a worktree nested under the repo root', () => {
    assert.ok(
      projectDirsFor('C:/GitHub/Cockpit', allDirs).includes('C--GitHub-Cockpit--claude-worktrees-angry-poitras-12220a'),
    );
  });

  it('does not match a sibling directory whose name merely starts with the same letters', () => {
    // `Cockpit2` and `CockpitOther` sanitize to `C--GitHub-Cockpit2` and `C--GitHub-CockpitOther` -
    // real string prefixes of `C--GitHub-Cockpit` with no dash boundary, so they are not this repo.
    const matched = projectDirsFor('C:/GitHub/Cockpit', allDirs);
    assert.ok(!matched.includes('C--GitHub-Cockpit2'));
    assert.ok(!matched.includes('C--GitHub-CockpitOther'));
  });

  it('does not match an unrelated directory', () => {
    assert.ok(!projectDirsFor('C:/GitHub/Cockpit', allDirs).includes('C--GitHub-SomethingElse'));
  });
});

describe('issueFromBranchName', () => {
  it('reads the issue number out of Cockpit\'s own branch convention', () => {
    assert.equal(issueFromBranchName('claude/github-issue-421-87dfba'), 421);
  });

  it('returns null for a branch that does not name an issue directly', () => {
    assert.equal(issueFromBranchName('claude/issue-392-drop-nightly-summary'), null);
    assert.equal(issueFromBranchName('claude/angry-poitras-12220a'), null);
    assert.equal(issueFromBranchName(undefined), null);
  });
});

describe('tokensOf', () => {
  it('reads every token kind this report breaks usage into', () => {
    const usage = {
      input_tokens: 2,
      cache_read_input_tokens: 58661,
      output_tokens: 168,
      cache_creation: { ephemeral_5m_input_tokens: 522, ephemeral_1h_input_tokens: 19151 },
    };
    assert.deepEqual(tokensOf(usage), { input: 2, cacheRead: 58661, cacheWrite5m: 522, cacheWrite1h: 19151, output: 168 });
  });

  it('defaults a missing usage or field to 0', () => {
    assert.deepEqual(tokensOf(undefined), { input: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 0 });
    assert.deepEqual(tokensOf({ input_tokens: 5 }), { input: 5, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 0 });
  });

  it('turns a non-numeric field into 0 rather than NaN, so it cannot poison a sum', () => {
    assert.deepEqual(tokensOf({ input_tokens: 'not a number' }).input, 0);
  });
});

describe('costOf', () => {
  const usage = (input) => ({ input_tokens: input, cache_read_input_tokens: 0, output_tokens: 0, cache_creation: {} });

  it('prices each model in the table at its own list rate', () => {
    assert.equal(costOf(usage(1_000_000), 'claude-opus-5', 'standard'), 5);
    assert.equal(costOf(usage(1_000_000), 'claude-sonnet-5', 'standard'), 2);
    assert.equal(costOf(usage(1_000_000), 'claude-haiku-4-5-20251001', 'standard'), 1);
  });

  it('applies the cache multipliers to the input rate', () => {
    const cacheUsage = {
      input_tokens: 0,
      cache_read_input_tokens: 1_000_000,
      output_tokens: 0,
      cache_creation: { ephemeral_5m_input_tokens: 1_000_000, ephemeral_1h_input_tokens: 1_000_000 },
    };
    // Sonnet 5: $2 input. Read 0.1x = $0.2, 5m write 1.25x = $2.5, 1h write 2x = $4.
    assert.equal(costOf(cacheUsage, 'claude-sonnet-5', 'standard'), 0.2 + 2.5 + 4);
  });

  it('prices Opus 5 at its fast-mode rate only when speed is fast', () => {
    assert.equal(costOf(usage(1_000_000), 'claude-opus-5', 'fast'), 10);
    assert.equal(costOf(usage(1_000_000), 'claude-opus-5', 'standard'), 5);
  });

  it('returns null for a model the pricing table does not carry, rather than pricing it at zero', () => {
    assert.equal(costOf(usage(1_000_000), 'claude-fable-5-1', 'standard'), null);
  });
});

describe('activeMillis', () => {
  const MIN = 60 * 1000;

  it('sums the gaps between consecutive timestamps', () => {
    assert.equal(activeMillis([0, 5 * MIN, 12 * MIN]), 12 * MIN);
  });

  it('leaves out a gap of 30 minutes or more, per issue 421', () => {
    const start = 0;
    const afterShortGap = start + 10 * MIN;
    const afterLongGap = afterShortGap + 45 * MIN;
    assert.equal(activeMillis([start, afterShortGap, afterLongGap]), 10 * MIN);
  });

  it('is 0 for zero or one timestamp', () => {
    assert.equal(activeMillis([]), 0);
    assert.equal(activeMillis([12345]), 0);
  });
});

describe('reviewLevel', () => {
  it('reads a bare level', () => {
    assert.equal(reviewLevel('xhigh'), 'xhigh');
  });

  it('finds the level among a target and flags, rather than returning the raw string', () => {
    // `/code-review 426 xhigh` and `/code-review xhigh --fix` are both real invocations
    // (code-review skill's own args) - the raw string was reported as a "level" verbatim
    // before this function existed, fragmenting one real level into several report keys.
    assert.equal(reviewLevel('426 xhigh'), 'xhigh');
    assert.equal(reviewLevel('xhigh --fix'), 'xhigh');
  });

  it('returns null for a flag-only or target-only call, which names no level of its own', () => {
    assert.equal(reviewLevel('--fix'), null);
    assert.equal(reviewLevel(''), null);
    assert.equal(reviewLevel(undefined), null);
  });
});

describe('dedupedFindings', () => {
  const SAME_KEY = () => 'issue-1';

  /** A line carrying one `ReportFindings` tool_use call. */
  function reportLine(findings) {
    return { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'ReportFindings', input: { findings } }] } };
  }

  it('keeps a lone report exactly as given', () => {
    const findings = [{ file: 'a.ts', line: 10, summary: 'x', category: 'correctness' }];
    const result = dedupedFindings([reportLine(findings)], SAME_KEY);
    assert.equal(result.length, 1);
    assert.deepEqual(result[0].findings, findings);
  });

  it('folds an initial report into its own re-report, keeping only the outcome-bearing call', () => {
    // The exact double-count this heuristic exists to prevent: issue 391's own pull request
    // recorded 8 findings, and treating both calls as distinct findings doubled that to 16.
    const initial = [
      { file: 'a.ts', line: 10, summary: 'first summary', category: 'correctness' },
      { file: 'b.ts', line: 20, summary: 'second summary', category: 'simplification' },
    ];
    const reReport = [
      { file: 'a.ts', line: 10, summary: 'first summary', category: 'correctness', outcome: 'fixed' },
      { file: 'b.ts', line: 20, summary: 'second summary', category: 'simplification', outcome: 'skipped' },
    ];
    const result = dedupedFindings([reportLine(initial), reportLine(reReport)], SAME_KEY);
    assert.equal(result.length, 1);
    assert.deepEqual(result[0].findings, reReport);
  });

  it('still matches a re-report whose summary text was reworded, by file and line alone', () => {
    // Confirmed against a real pair of calls: a summary's own embedded count changed once a
    // later fix landed, and another was reworded from present to past tense - matching on the
    // summary text too broke this exact case and brought the double-count back.
    const initial = [{ file: 'x.ts', line: 5, summary: 'the file goes from 16 calls to 25 per run', category: 'test-coverage' }];
    const reReport = [
      { file: 'x.ts', line: 5, summary: 'the file goes from 16 calls to 26 per run', category: 'test-coverage', outcome: 'skipped' },
    ];
    const result = dedupedFindings([reportLine(initial), reportLine(reReport)], SAME_KEY);
    assert.equal(result.length, 1);
    assert.equal(result[0].findings[0].outcome, 'skipped');
  });

  it('does not merge two same-length calls that report different findings', () => {
    const first = [{ file: 'a.ts', line: 1, summary: 'one', category: 'correctness' }];
    const second = [{ file: 'b.ts', line: 2, summary: 'two', category: 'efficiency' }];
    const result = dedupedFindings([reportLine(first), reportLine(second)], SAME_KEY);
    assert.equal(result.length, 2);
  });

  it('never lets a call under one issue supersede a same-shaped call under another', () => {
    // The scenario this module's own top comment names: one transcript can span two issues, so
    // an unrelated review that happens to match by shape must never fold into this one's findings.
    const findingsA = [{ file: 'a.ts', line: 1, summary: 'x', category: 'correctness' }];
    const findingsB = [{ file: 'a.ts', line: 1, summary: 'x', category: 'correctness', outcome: 'fixed' }];
    const lines = [reportLine(findingsA), reportLine(findingsB)];
    const differentKeys = (lineIndex) => (lineIndex === 0 ? 'issue-1' : 'issue-2');
    const result = dedupedFindings(lines, differentKeys);
    assert.equal(result.length, 2, 'both calls survive - they belong to different issues, so neither supersedes the other');
  });
});

describe("An issue's cost by session phase", () => {
  const at = (minute) => new Date(Date.UTC(2026, 9, 3, 10, minute)).toISOString();
  const ms = (minute) => Date.parse(at(minute));
  const marks = normaliseMarks([
    { at: at(10), phase: 'start' },
    { at: at(20), phase: 'scoped' },
    { at: at(30), phase: 'built' },
    { at: at(40), phase: 'review-start', kind: 'code-review', level: 'high' },
    { at: at(45), phase: 'review-end', kind: 'code-review', level: 'high' },
    { at: at(50), phase: 'pushed' },
    { at: at(60), phase: 'review-start', kind: 'code-review', level: 'low' },
    { at: at(65), phase: 'review-end', kind: 'code-review', level: 'low' },
  ]);

  describe('each line goes to the phase whose mark last preceded it', () => {
    for (const { situation, minute, phase } of [
    { situation: 'a line before the session started', minute: 5, phase: 'outsideRun' },
    { situation: 'a line between start and scoped', minute: 15, phase: 'scoping' },
    { situation: 'a line between scoped and built', minute: 25, phase: 'building' },
    { situation: 'a line between built and a review, before pushing', minute: 35, phase: 'building' },
    { situation: 'a line inside a review window', minute: 42, phase: 'localReview' },
    { situation: 'a line after the review, before pushing', minute: 47, phase: 'building' },
    { situation: 'a line after pushed', minute: 55, phase: 'afterPush' },
    { situation: 'a line inside a review window after pushed', minute: 62, phase: 'localReview' },
    { situation: 'a line after that review window', minute: 70, phase: 'afterPush' },
    ]) {
      it(situation, () => {
        assert.equal(phaseAt(marks, ms(minute)), phase);
      });
    }
  });

  it('counts a review window left open as review to the end of the record', () => {
    assert.equal(phaseAt(normaliseMarks([{ at: at(1), phase: 'start' }, { at: at(2), phase: 'review-start' }]), ms(30)), 'localReview');
  });

  it('stays local review while any review window is open, overlapping ones included', () => {
    const overlapping = normaliseMarks([
      { at: at(10), phase: 'start' },
      { at: at(40), phase: 'review-start', kind: 'code-review', level: 'high' },
      { at: at(41), phase: 'review-start', kind: 'security-review', level: 'high' },
      { at: at(45), phase: 'review-end', kind: 'code-review', level: 'high' },
      { at: at(55), phase: 'review-end', kind: 'security-review', level: 'high' },
      { at: at(58), phase: 'pushed' },
    ]);
    assert.equal(phaseAt(overlapping, ms(50)), 'localReview');
    assert.equal(phaseAt(overlapping, ms(56)), 'scoping');
  });

  /** One request in `phase`, 1,000,000 input and 100,000 output tokens of Sonnet 5: $2.00 and $1.00 a request. */
  function request(phase) {
    return {
      model: 'claude-sonnet-5',
      speed: 'standard',
      usage: { input_tokens: 1_000_000, output_tokens: 100_000, cache_creation: {} },
      phase,
    };
  }
  function statsWith(entries, subagentEntries = []) {
    const stats = emptyIssueStats(669);
    entries.forEach((entry, i) => stats.requests.main.set(`m${i}`, entry));
    subagentEntries.forEach((entry, i) => stats.requests.subagent.set(`s${i}`, entry));
    return stats;
  }

  it("the phases add up to the issue's total", () => {
    const report = summarize(
      statsWith([request('scoping'), request('building'), request('building'), request('localReview'), request('afterPush')], [
        request('afterPush'),
        request('outsideRun'),
      ]),
    );
    const phases = Object.values(report.phases);
    const sum = (read) => phases.reduce((total, phase) => total + read(phase), 0);
    assert.equal(Math.round(sum((p) => p.costUSD) * 10000), Math.round(report.costUSD.total * 10000));
    for (const kind of Object.keys(report.tokens)) assert.equal(sum((p) => p.tokens[kind]), report.tokens[kind], kind);
    assert.equal(report.phases.building.costUSD, 6);
    assert.equal(report.phases.afterPush.tokens.output, 200_000);
  });

  it('fractional phase costs still add up exactly to the total once rounded', () => {
    // Three phases at $0.00005 a request each round to 0.0001 apiece (0.0003) against a total of 0.00015 -> 0.0002.
    const tiny = (phase) => ({ model: 'claude-sonnet-5', speed: 'standard', usage: { input_tokens: 25, cache_creation: {} }, phase });
    const report = summarize(statsWith([tiny('scoping'), tiny('building'), tiny('afterPush')]));
    const sum = Object.values(report.phases).reduce((total, p) => total + Math.round(p.costUSD * 10000), 0);
    assert.equal(sum, Math.round(report.costUSD.total * 10000));
  });

  it('a request on a model with no price counts as unpriced in its phase, not as cost', () => {
    const unpriced = { ...request('afterPush'), model: 'claude-fable-5-1' };
    const report = summarize(statsWith([request('building'), unpriced]));
    assert.equal(report.phases.afterPush.costUSD, 0);
    assert.equal(report.phases.afterPush.unpricedTokens, 1_100_000);
    assert.equal(report.unpricedTokens, 1_100_000);
  });

  it('an issue whose requests have no record is left unsplit and says so', () => {
    const report = summarize(statsWith([request('unrecorded'), request('unrecorded')]));
    assert.equal(report.phases, null);
    assert.equal(report.phasesNote, 'no session record');
    assert.equal(report.costUSD.total, 6);
  });

  it('a request from a branch with no record is kept apart from the phases of one that has', () => {
    const report = summarize(statsWith([request('building'), request('unrecorded')]));
    assert.equal(report.phases.building.costUSD, 3);
    assert.equal(report.phases.unrecorded.costUSD, 3);
    assert.equal(report.phasesNote, null);
  });

  describe('a pull request without a readable record leaves the issue unsplit', () => {
    for (const { situation, body } of [
    { situation: 'a body with no session record block', body: '## Summary\n\nSomething.' },
    { situation: 'a body with only the start marker', body: `text\n${BLOCK_START}\n- ${at(1)} start\n` },
    { situation: 'a body with only the end marker', body: `text\n- ${at(1)} start\n${BLOCK_END}` },
    { situation: 'a block carrying no marks', body: `${BLOCK_START}\n### Session record\n${BLOCK_END}` },
    { situation: 'no body at all', body: null },
    ]) {
      it(situation, () => {
        assert.equal(marksFromBody(body), null);
      });
    }
  });

  it('reads the marks of a body with a complete block', () => {
    const body = `## Summary\n\n${BLOCK_START}\n### Session record\n\n- ${at(1)} start\n- ${at(2)} pushed\n${BLOCK_END}`;
    assert.deepEqual(marksFromBody(body), [
      { phase: 'start', kind: undefined, ms: ms(1) },
      { phase: 'pushed', kind: undefined, ms: ms(2) },
    ]);
  });

  it('the JSON output carries each phase\'s tokens and cost', () => {
    const json = JSON.parse(JSON.stringify(summarize(statsWith([request('scoping'), request('afterPush')]))));
    assert.deepEqual(Object.keys(json.phases), ['outsideRun', 'scoping', 'building', 'localReview', 'afterPush', 'unrecorded']);
    assert.equal(json.phases.scoping.costUSD, 3);
    assert.equal(json.phases.afterPush.tokens.input, 1_000_000);
    assert.equal(json.phases.building.costUSD, 0);
  });
});
