import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  activeMillis,
  costOf,
  dedupedFindings,
  issueFromBranchName,
  projectDirsFor,
  reviewLevel,
  sanitizePath,
  tokensOf,
} from './issue-cost.mjs';

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
