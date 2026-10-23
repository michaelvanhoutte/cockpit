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

  describe('a pull request closed without merging is not sent', () => {
    it('leaves it out', () => {
      expect(monitorRows({ pulls: [pull({ mergedAt: null })] })).toEqual([]);
    });
  });
});
