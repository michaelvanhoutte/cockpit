import { describe, expect, it } from 'vitest';

import { renderBlock } from '../../../../scripts/lib/session-record.mjs';
import { monitorRows } from '../../src/model.js';

const MIN = 60_000;
const BASE = Date.UTC(2026, 8, 15, 9, 0);
/** A moment, as minutes past 09:00 on the 15th. */
const at = (minutes) => new Date(BASE + minutes * MIN).toISOString();

let nextId = 1;
/** A check run from minute `from` to minute `to`. */
const check = (name, from, to, conclusion = 'success', overrides = {}) => ({
  id: nextId++,
  name,
  suiteId: 1,
  status: 'completed',
  conclusion,
  startedAt: at(from),
  completedAt: at(to),
  ...overrides,
});
const pull = (overrides = {}) => ({
  number: 1,
  title: 'A change',
  url: 'https://github.com/o/r/pull/1',
  createdAt: at(0),
  mergedAt: at(60),
  body: '',
  base: 'main',
  head: 'claude/1-a-change',
  additions: 10,
  deletions: 2,
  changedFiles: 3,
  commitCount: 1,
  commits: [],
  ...overrides,
});

const recorded = renderBlock([{ at: at(0), phase: 'start' }]);

/** Round one of the pull request: Checks queued for a minute, then Test failing on a spec and passing on its re-run. */
const flukyCommit = {
  sha: 'a'.repeat(40),
  authoredAt: at(0),
  parents: 1,
  checks: [
    check('Checks', 2, 5, 'success', { queue: { state: 'read', createdAt: at(1), startedAt: at(2) } }),
    check('Test', 3, 12, 'failure', {
      failure: { steps: ['Run the tests'], record: { state: 'read', value: { packages: [{ name: 'api', files: [{ path: 'a.test.ts', status: 'failed' }] }] } } },
    }),
    check('Test', 14, 20),
  ],
};

describe('Cycle time', () => {
  describe("a merged pull request is cut into the rows the Harness Monitor stores: its time split, its rounds and each round's checks", () => {
    it('gives a recorded pull request its writing, local, CI and waiting time, adding up to the balance it is judged by', () => {
      const [row] = monitorRows({ pulls: [pull({ body: recorded, commits: [flukyCommit] })] });

      expect(row).toMatchObject({
        number: 1,
        mergedAt: at(60),
        base: 'main',
        landing: false,
        recorded: true,
        start: { from: 'session-record' },
        // Two minutes from the session's start to the push, and nothing run locally in them.
        codingMs: 2 * MIN,
        localMs: 0,
        // The round ran from the push, at minute 2, to the re-run finishing at minute 20.
        ciMs: 18 * MIN,
        waitingToMergeMs: 40 * MIN,
        awayMs: 0,
        totalMs: 60 * MIN,
      });
    });

    it('lists each attempt that ran in the order they finished, marking the one that finished last and the queue each waited', () => {
      const [row] = monitorRows({ pulls: [pull({ body: recorded, commits: [flukyCommit] })] });

      expect(row.rounds).toHaveLength(1);
      expect(row.rounds[0]).toMatchObject({ sha: 'a'.repeat(40), red: false, commits: 1, queueNotRecorded: false, ms: 18 * MIN });
      expect(row.rounds[0].checks.map((c) => [c.name, c.attempt, c.heldMs / MIN, c.last, c.queuedMs === null ? null : c.queuedMs / MIN])).toEqual([
        ['Checks', 1, 3, false, 1],
        ['Test', 1, 7, false, null],
        ['Test', 2, 8, true, null],
      ]);
    });

    it('marks a failed attempt a fluke where its re-run passed, with the minutes the re-run added and what the attempt died on', () => {
      const [row] = monitorRows({ pulls: [pull({ body: recorded, commits: [flukyCommit] })] });

      const [, failed, rerun] = row.rounds[0].checks;

      expect(failed).toMatchObject({ failure: 'fluke', flukeMs: 8 * MIN, failedSteps: ['Run the tests'], failedFiles: ['a.test.ts'], detailNotRecorded: false, noFileFailed: false });
      expect(rerun).toMatchObject({ failure: null, flukeMs: null, failedSteps: [], failedFiles: [] });
    });

    it('marks a check red where it never passed on the commit, and the round red with it', () => {
      const red = { ...flukyCommit, checks: [check('Test', 3, 12, 'failure', { failure: { steps: ['Run the tests'], record: { state: 'not-recorded', why: 'expired' } } })] };

      const [row] = monitorRows({ pulls: [pull({ body: recorded, commits: [red] })] });

      expect(row.rounds[0].red).toBe(true);
      expect(row.rounds[0].checks[0]).toMatchObject({ failure: 'red', flukeMs: null, failedSteps: ['Run the tests'], failedFiles: [], detailNotRecorded: true });
    });

    it('keeps the first 500 failed files of an attempt, each cut to 500 characters, and marks its detail not wholly recorded, so one wholesale failure cannot make the Monitor refuse the night', () => {
      const files = Array.from({ length: 600 }, (_, index) => `${'d/'.repeat(300)}${index}.test.ts`);
      const wholesale = {
        ...flukyCommit,
        checks: [check('Test', 3, 12, 'failure', { failure: { steps: ['Run the tests'], record: { state: 'read', value: { packages: [{ name: 'api', files: files.map((path) => ({ path, status: 'failed' })) }] } } } })],
      };

      const [row] = monitorRows({ pulls: [pull({ body: recorded, commits: [wholesale] })] });
      const kept = row.rounds[0].checks[0].failedFiles;

      expect(row.rounds[0].checks[0].detailNotRecorded).toBe(true);
      expect(kept).toHaveLength(500);
      expect(kept.every((path) => path.length === 500)).toBe(true);
      expect(kept[0]).toBe(files[0].slice(0, 500));
    });
  });

  describe('a pull request with no session record is sent as not recorded, never as zero', () => {
    it('leaves its writing and local time and its local reviews null, beside the CI time it did have', () => {
      const [row] = monitorRows({ pulls: [pull({ body: '', commits: [flukyCommit] })] });

      expect(row).toMatchObject({
        recorded: false,
        start: { from: 'first-commit' },
        codingMs: null,
        localMs: null,
        localReviews: null,
        localRuns: { test: null, browser: null },
      });
      expect(row.ciMs).toBe(18 * MIN);
    });
  });

  describe('the local reviews are sent combined and by kind, so the Monitor can draw each', () => {
    const marked = (marks) => renderBlock([{ at: at(0), phase: 'start' }, ...marks.map(([minute, phase, kind]) => ({ at: at(minute), phase, kind, level: 'high' }))]);
    const review = (kind, from, to) => [[from, 'review-start', kind], [to, 'review-end', kind]];

    it.each([
      {
        situation: 'a code review and a security review that overlapped',
        marks: [...review('code-review', 1, 11), ...review('security-review', 6, 10)],
        sent: { count: 2, ms: 10 * MIN, byKind: { 'code-review': { count: 1, ms: 10 * MIN }, 'security-review': { count: 1, ms: 4 * MIN } } },
      },
      {
        situation: 'a code review alone, the security review none',
        marks: review('code-review', 1, 6),
        sent: { count: 1, ms: 5 * MIN, byKind: { 'code-review': { count: 1, ms: 5 * MIN }, 'security-review': { count: 0, ms: 0 } } },
      },
    ])('$situation', ({ marks, sent }) => {
      const [row] = monitorRows({ pulls: [pull({ body: marked(marks), commits: [flukyCommit] })] });

      expect(row.localReviews).toEqual(sent);
    });

    it('sends none where the record marked no review', () => {
      const [row] = monitorRows({ pulls: [pull({ body: recorded, commits: [flukyCommit] })] });

      expect(row.localReviews).toBeNull();
    });
  });

  describe("a pull request's local check kinds, counted once, add up exactly to its local minutes, each shared minute going to the check that ends last", () => {
    /** Code reviews, security reviews, test runs and browser passes as `[from, to]` minutes, before the one round at minutes 40 to 50. */
    const withLocal = ({ codeReviews = [], securityReviews = [], tests = [], browser = [] }) => {
      const review = (kind) => ([from, to]) => [{ at: at(from), phase: 'review-start', kind, level: 'high' }, { at: at(to), phase: 'review-end', kind, level: 'high' }];
      const body = renderBlock([
        { at: at(0), phase: 'start' },
        ...codeReviews.flatMap(review('code-review')),
        ...securityReviews.flatMap(review('security-review')),
        ...browser.flatMap(([from, to]) => [{ at: at(from), phase: 'browser-start' }, { at: at(to), phase: 'browser-end' }]),
        ...tests.map(([from, to]) => ({ run: 'test', scopes: ['api'], start: at(from), end: at(to) })),
      ]);
      const [row] = monitorRows({ pulls: [pull({ body, commits: [{ sha: 'a'.repeat(40), authoredAt: at(0), parents: 1, checks: [check('Test', 40, 50)] }] })] });
      return row;
    };
    const inMinutes = (parts) => Object.fromEntries(Object.entries(parts).map(([kind, ms]) => [kind, ms / MIN]));

    it.each([
      {
        situation: 'a code review and a test run overlapping by 10 minutes, the test run ending last',
        local: { codeReviews: [[5, 25]], tests: [[15, 35]] },
        parts: { 'code-review': 10, 'security-review': 0, test: 20, browser: 0 },
      },
      {
        situation: 'a browser pass wholly inside a test run that ends later',
        local: { tests: [[5, 30]], browser: [[10, 20]] },
        parts: { 'code-review': 0, 'security-review': 0, test: 25, browser: 0 },
      },
      {
        situation: 'a code review and a test run ending at the same moment, the code review starting later',
        local: { codeReviews: [[10, 20]], tests: [[5, 20]] },
        parts: { 'code-review': 10, 'security-review': 0, test: 5, browser: 0 },
      },
      {
        situation: 'a security review and a browser pass over exactly the same minutes',
        local: { securityReviews: [[10, 20]], browser: [[10, 20]] },
        parts: { 'code-review': 0, 'security-review': 0, test: 0, browser: 10 },
      },
      {
        situation: 'all four kinds, one after another with no overlap',
        local: { codeReviews: [[1, 5]], securityReviews: [[6, 8]], tests: [[10, 20]], browser: [[25, 30]] },
        parts: { 'code-review': 4, 'security-review': 2, test: 10, browser: 5 },
      },
      {
        situation: 'a code review alone, the other kinds marked none of',
        local: { codeReviews: [[5, 12]] },
        parts: { 'code-review': 7, 'security-review': 0, test: 0, browser: 0 },
      },
    ])('$situation', ({ local, parts }) => {
      const row = withLocal(local);

      expect(inMinutes(row.localParts)).toEqual(parts);
      expect(Object.values(row.localParts).reduce((total, ms) => total + ms, 0)).toBe(row.localMs);
    });

    it('gives the shared minutes of two checks ending together to the same one whichever was marked first', () => {
      const one = withLocal({ codeReviews: [[10, 20]], securityReviews: [[10, 20]] });
      const marks = renderBlock([
        { at: at(0), phase: 'start' },
        { at: at(10), phase: 'review-start', kind: 'security-review', level: 'high' },
        { at: at(10), phase: 'review-start', kind: 'code-review', level: 'high' },
        { at: at(20), phase: 'review-end', kind: 'security-review', level: 'high' },
        { at: at(20), phase: 'review-end', kind: 'code-review', level: 'high' },
      ]);
      const [other] = monitorRows({ pulls: [pull({ body: marks, commits: [{ sha: 'a'.repeat(40), authoredAt: at(0), parents: 1, checks: [check('Test', 40, 50)] }] })] });

      expect(inMinutes(one.localParts)).toEqual({ 'code-review': 0, 'security-review': 10, test: 0, browser: 0 });
      expect(other.localParts).toEqual(one.localParts);
    });

    it('leaves a review of a kind the session record does not know out of the local time, so the parts still add up to it', () => {
      const body = renderBlock([
        { at: at(0), phase: 'start' },
        { at: at(5), phase: 'review-start', kind: 'design-review', level: 'high' },
        { at: at(15), phase: 'review-end', kind: 'design-review', level: 'high' },
        { at: at(20), phase: 'review-start', kind: 'code-review', level: 'high' },
        { at: at(25), phase: 'review-end', kind: 'code-review', level: 'high' },
      ]);
      const [row] = monitorRows({ pulls: [pull({ body, commits: [{ sha: 'a'.repeat(40), authoredAt: at(0), parents: 1, checks: [check('Test', 40, 50)] }] })] });

      expect(inMinutes(row.localParts)).toEqual({ 'code-review': 5, 'security-review': 0, test: 0, browser: 0 });
      expect(row.localMs).toBe(5 * MIN);
    });

    it('sends no parts, not zeroes, for a pull request with no session record', () => {
      const [row] = monitorRows({ pulls: [pull({ body: '', commits: [flukyCommit] })] });

      expect(row.localParts).toBeNull();
    });
  });

  describe("a check attempt's running time is the runner time its jobs used, so a pull request's attempts add up to its GitHub Actions runner minutes", () => {
    const sha = (letter) => letter.repeat(40);
    const commit = (letter, checks) => ({ sha: sha(letter), authoredAt: at(0), parents: 1, checks });
    /** Each attempt sent, as `[round, name, attempt, minutes of running time]`. */
    const runningOf = (row) => row.rounds.flatMap((round, index) => round.checks.map((c) => [index + 1, c.name, c.attempt, c.runningMs / MIN]));
    const shards = (spans, conclusion = 'success', overrides = {}) => spans.map(([from, to], index) => check(`E2E (F3) (${index + 1})`, from, to, conclusion, overrides));
    /** A re-run's copy of a job that passed: created at minute 20, carrying the start and end of the job it copies. */
    const copyOf = (job) => ({ ...job, id: nextId++, queue: { state: 'read', createdAt: at(20), startedAt: job.startedAt } });

    const [first, failing, third, fourth] = shards([[2, 7], [2, 8], [2, 6], [2, 7]]);
    failing.conclusion = 'failure';

    it.each([
      {
        situation: "E2E's four shards of 5, 6, 4 and 5 minutes and its fan-in of 1, in one attempt",
        commits: [commit('a', [...shards([[2, 7], [2, 8], [2, 6], [2, 7]]), check('E2E (F3)', 8, 9)])],
        running: [[1, 'E2E (F3)', 1, 21]],
      },
      {
        situation: 'a check that failed and was re-run, each attempt its own job',
        commits: [commit('a', [check('Test', 3, 12, 'failure'), check('Test', 14, 20)])],
        running: [[1, 'Test', 1, 9], [1, 'Test', 2, 6]],
      },
      {
        situation: 'a family whose failed shard was re-run, the shards that passed copied: only the re-run shard and its fan-in ran again',
        commits: [commit('a', [first, failing, third, fourth, check('E2E (F3)', 8, 9, 'failure'), copyOf(first), copyOf(third), copyOf(fourth), check('E2E (F3) (2)', 20, 26), check('E2E (F3)', 27, 28)])],
        running: [[1, 'E2E (F3)', 1, 21], [1, 'E2E (F3)', 2, 7]],
      },
      {
        situation: 'a family whose failed shard alone was re-run, the others standing in with their first attempt, which is not counted again',
        commits: [commit('a', [first, failing, third, fourth, check('E2E (F3)', 8, 9, 'failure'), check('E2E (F3) (2)', 20, 26), check('E2E (F3)', 27, 28)])],
        running: [[1, 'E2E (F3)', 1, 21], [1, 'E2E (F3)', 2, 7]],
      },
      {
        situation: 'a job cancelled by the next push after 3 minutes',
        commits: [commit('a', [check('Test', 2, 5, 'cancelled')]), commit('b', [check('Test', 5, 10)])],
        running: [[1, 'Test', 1, 3], [2, 'Test', 1, 5]],
      },
      {
        situation: 'a job that queued 2 minutes and ran 4',
        commits: [commit('a', [check('Test', 3, 7, 'success', { queue: { state: 'read', createdAt: at(1), startedAt: at(3) } })])],
        running: [[1, 'Test', 1, 4]],
      },
      {
        situation: 'a job cancelled before a runner took it, beside a skipped one that sends no attempt',
        commits: [commit('a', [check('Test', 2, 6), check('Checks', 4, 4, 'cancelled'), check('Pages', 3, 3, 'skipped')])],
        running: [[1, 'Checks', 1, 0], [1, 'Test', 1, 4]],
      },
    ])('$situation', ({ commits, running }) => {
      const [row] = monitorRows({ pulls: [pull({ body: recorded, commits })] });

      expect(runningOf(row)).toEqual(running);
    });

    it("adds up, over every attempt of a pull request, to its runner total", () => {
      const commits = [
        commit('a', [
          check('Checks', 2, 5, 'success', { queue: { state: 'read', createdAt: at(1), startedAt: at(2) } }),
          check('Test', 3, 12, 'failure'),
          check('Test', 14, 20),
          first, failing, third, fourth,
          check('E2E (F3)', 8, 9, 'failure'),
          copyOf(first), copyOf(third), copyOf(fourth),
          check('E2E (F3) (2)', 20, 26),
          check('E2E (F3)', 27, 28),
          check('Pages', 3, 3, 'skipped'),
          check('Lint', 25, 29, 'cancelled'),
        ]),
        commit('b', [check('Checks', 29, 33), check('Lint', 30, 30, 'cancelled'), check('Test', 30, 41)]),
      ];

      const [row] = monitorRows({ pulls: [pull({ body: recorded, commits })] });

      expect(row.runnerMs).toBe(65 * MIN);
      expect(runningOf(row).reduce((total, [, , , minutes]) => total + minutes, 0) * MIN).toBe(row.runnerMs);
    });
  });

  describe('a pull request closed without merging is not sent', () => {
    it('leaves it out', () => {
      expect(monitorRows({ pulls: [pull({ mergedAt: null })] })).toEqual([]);
    });
  });
});
