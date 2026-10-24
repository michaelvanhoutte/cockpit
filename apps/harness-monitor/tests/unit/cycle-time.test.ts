import { describe, expect, it } from 'vitest';
import { checkPulls, MAX_PULLS } from '../../src/cycle-time';

const check = (over: Record<string, unknown> = {}) => ({
  name: 'Test',
  attempt: 1,
  heldMs: 200_000,
  last: true,
  failure: null,
  flukeMs: null,
  queuedMs: 5_000,
  detailNotRecorded: false,
  noFileFailed: false,
  failedSteps: [],
  failedFiles: [],
  ...over,
});

const round = (over: Record<string, unknown> = {}) => ({
  sha: 'a'.repeat(40),
  pushedAt: '2026-10-01T10:00:00Z',
  endedAt: '2026-10-01T10:05:00Z',
  ms: 300_000,
  red: false,
  commits: 1,
  queueNotRecorded: false,
  checks: [check()],
  ...over,
});

const pull = (number: number, over: Record<string, unknown> = {}) => ({
  number,
  title: 'Add a thing',
  url: `https://github.com/o/r/pull/${number}`,
  mergedAt: '2026-10-01T12:00:00Z',
  base: 'main',
  head: 'claude/1-thing',
  landing: false,
  size: { additions: 30, deletions: 10, files: 3, commits: 2, mainMerges: 0 },
  start: { at: '2026-10-01T08:00:00Z', from: 'session-record' },
  recorded: true,
  codingMs: 600_000,
  localMs: 300_000,
  ciMs: 300_000,
  waitingToMergeMs: 60_000,
  awayMs: 0,
  totalMs: 14_400_000,
  localReviews: { count: 2, ms: 300_000 },
  localRuns: { test: null, browser: null },
  runnerMs: 600_000,
  cancelled: { superseded: { runs: 0, ms: 0 }, other: { runs: 0, ms: 0 } },
  rounds: [round()],
  ...over,
});

const refusal = (pulls: unknown[]) => {
  const checked = checkPulls({ pulls });
  return checked.ok ? null : checked.error;
};

describe('Harness Monitor', () => {
  describe("a send of cycle time's pull requests holding any row of the wrong shape, or too many pull requests, is refused whole, naming the row", () => {
    it.each([
      {
        situation: 'a round with no checks field',
        pulls: [pull(1), pull(2, { rounds: [round(), round({ checks: undefined })] })],
        error: 'Pull request 1 (#2): round 1 (aaaaaaa) has no list of checks.',
      },
      {
        situation: "a check's duration that is negative",
        pulls: [pull(3, { rounds: [round({ checks: [check(), check({ name: 'Lint', heldMs: -5 })] })] })],
        error: 'Pull request 0 (#3): round 0 (aaaaaaa) check 1 (Lint) has heldMs -5, which is not a whole number of milliseconds, zero or more.',
      },
      {
        situation: "a pull request's time that is not a number",
        pulls: [pull(4, { ciMs: '5 minutes' })],
        error: 'Pull request 0 (#4): has ciMs "5 minutes", which is not a whole number of milliseconds, zero or more.',
      },
      {
        situation: 'writing time claimed by a pull request with no session record',
        pulls: [pull(5, { recorded: false })],
        error: 'Pull request 0 (#5): has writing or local time but no session record.',
      },
      {
        situation: 'a merge time without a time zone',
        pulls: [pull(6, { mergedAt: '2026-10-01 12:00' })],
        error: 'Pull request 0 (#6): has a mergedAt that is not an ISO 8601 timestamp with a time zone.',
      },
      {
        situation: 'a failure that is neither red nor a fluke',
        pulls: [pull(7, { rounds: [round({ checks: [check({ failure: 'flaky' })] })] })],
        error: 'Pull request 0 (#7): round 0 (aaaaaaa) check 0 (Test) has failure "flaky", which is not red, fluke or null.',
      },
      {
        situation: 'more pull requests than one send takes',
        pulls: Array.from({ length: MAX_PULLS + 1 }, (_, i) => pull(i + 1)),
        error: `The send has ${MAX_PULLS + 1} pull requests; the most one send takes is ${MAX_PULLS}.`,
      },
      {
        situation: 'the same pull request twice',
        pulls: [pull(8), pull(8)],
        error: 'Pull request 1 (#8): is in the send twice.',
      },
    ])('$situation', ({ pulls, error }) => {
      expect(refusal(pulls)).toBe(error);
    });

    it('a pull request no check ever ran on, with no rounds and no waiting to merge, is taken', () => {
      expect(refusal([pull(9, { rounds: [], waitingToMergeMs: null, ciMs: 0, codingMs: null, localMs: null })])).toBeNull();
    });

    it('a pull request with no session record, its writing and local time null, is taken as not recorded', () => {
      const checked = checkPulls({ pulls: [pull(10, { recorded: false, codingMs: null, localMs: null, localReviews: null })] });

      expect(checked.ok && checked.pulls[0]).toMatchObject({ number: 10, recorded: false, codingMs: null, localMs: null, localReviews: null });
    });
  });

  describe("a send's local reviews carry each kind's own figures, or none, never a half", () => {
    const kinds = { 'code-review': { count: 1, ms: 240_000 }, 'security-review': { count: 1, ms: 120_000 } };

    it('takes both kinds beside the combined figure', () => {
      const checked = checkPulls({ pulls: [pull(11, { localReviews: { count: 2, ms: 300_000, byKind: kinds } })] });

      expect(checked.ok && checked.pulls[0]!.localReviews).toEqual({ count: 2, ms: 300_000, byKind: kinds });
    });

    it('takes a send from a job that does not send the kinds yet, which reads as not recorded', () => {
      const checked = checkPulls({ pulls: [pull(12, { localReviews: { count: 2, ms: 300_000 } })] });

      expect(checked.ok && checked.pulls[0]!.localReviews).toEqual({ count: 2, ms: 300_000, byKind: null });
    });

    it.each([
      { situation: 'one kind missing', byKind: { 'code-review': kinds['code-review'] }, error: 'Pull request 0 (#13): has no localReviews.byKind.security-review.' },
      { situation: 'a kind that is null', byKind: { ...kinds, 'security-review': null }, error: 'Pull request 0 (#13): has no localReviews.byKind.security-review.' },
      { situation: 'a kind with a negative duration', byKind: { ...kinds, 'code-review': { count: 1, ms: -1 } }, error: 'Pull request 0 (#13): localReviews.byKind.code-review has ms -1, which is not a whole number of milliseconds, zero or more.' },
      { situation: 'kinds that are not an object', byKind: 'both', error: 'Pull request 0 (#13): has localReviews.byKind that is not an object.' },
    ])('refuses the send for $situation', ({ byKind, error }) => {
      expect(refusal([pull(13, { localReviews: { count: 2, ms: 300_000, byKind } })])).toBe(error);
    });
  });
});
