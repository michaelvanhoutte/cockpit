import { SELF } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CycleTimeAnswer } from '../../src/cycle-time-store';
import { cycleCheck, cyclePull, cycleRound, emptyTheDatabase, sendPulls } from './support';

beforeEach(emptyTheDatabase);
afterEach(() => vi.useRealTimers());

const theAnswer = async (query = ''): Promise<CycleTimeAnswer> => {
  const response = await SELF.fetch(`https://monitor.test/cycle-time?format=json${query.replace('?', '&')}`);
  expect(response.status).toBe(200);
  return response.json();
};

/** A pull request merged at `mergedAt`, one round of a `Test` check that waited `queuedMs` for a runner. */
const queued = (number: number, mergedAt: string, queuedMs: number) =>
  cyclePull(number, { mergedAt, rounds: [cycleRound([cycleCheck('Test', 200_000, { last: true, queuedMs })])] });

/** A pull request whose one round was red at the step `step`, with the test file `file` failing. */
const redAt = (number: number, step: string, file: string) =>
  cyclePull(number, {
    mergedAt: '2026-10-30T10:00:00Z',
    rounds: [
      cycleRound([cycleCheck('Test', 200_000, { last: true, failure: 'red', failedSteps: [step], failedFiles: [file] })], { red: true }),
    ],
  });

describe('Harness Monitor', () => {
  describe("cycle time's stored pull requests answer for the period asked, as JSON, with what the harness cost review reads", () => {
    it('with nothing stored, the answer is empty and names the period', async () => {
      vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-31T12:00:00Z') });

      const answer = await theAnswer();

      expect(answer).toMatchObject({ period: '30d', firstDay: '2026-10-02', pulls: [] });
      expect(answer.windows.map((w) => [w.days, w.firstDay, w.pulls.total, w.rounds, w.cancelled, w.queue])).toEqual([
        [7, '2026-10-25', 0, null, null, null],
        [14, '2026-10-18', 0, null, null, null],
        [30, '2026-10-02', 0, null, null, null],
      ]);
    });

    it("counts only the pull requests merged from the start of the period's first Belgian day", async () => {
      vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-20T12:00:00Z') });
      // 14 Oct begins in Brussels at 22:00 UTC on the 13th.
      await sendPulls([queued(1, '2026-10-13T21:59:00Z', 1_000), queued(2, '2026-10-13T22:00:00Z', 1_000)]);

      const answer = await theAnswer('?period=7d');

      expect(answer.firstDay).toBe('2026-10-14');
      expect(answer.pulls.map((p) => p.number)).toEqual([2]);
      expect(answer.windows.map((w) => [w.days, w.pulls.total])).toEqual([[7, 1]]);
    });

    it('a window with three red rounds at one failing step names that step, counted 3, and the test file with it', async () => {
      vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-31T12:00:00Z') });
      await sendPulls([
        redAt(1, 'Run the tests', 'a.test.ts'),
        redAt(2, 'Run the tests', 'a.test.ts'),
        redAt(3, 'Run the tests', 'b.test.ts'),
        cyclePull(4, { mergedAt: '2026-09-10T12:00:00Z' }),
      ]);

      const { windows } = await theAnswer();
      const failures = windows.find((w) => w.days === 14)!.failures;

      expect(failures.attempts).toBe(3);
      expect(failures.steps).toEqual([
        { check: 'Test', step: 'Run the tests', attempts: 3, pulls: [1, 2, 3].map((number) => ({ number, attempts: 1 })) },
      ]);
      expect(failures.files.map((f) => [f.path, f.attempts, f.pulls.length])).toEqual([
        ['a.test.ts', 2, 2],
        ['b.test.ts', 1, 1],
      ]);
      expect(windows.find((w) => w.days === 14)!.rounds).toMatchObject({ count: 3, red: 3 });
    });

    it('a step failing twice on one pull request is one pull request and two attempts', async () => {
      vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-31T12:00:00Z') });
      const twice = cyclePull(1, {
        mergedAt: '2026-10-30T10:00:00Z',
        rounds: [
          cycleRound(
            [
              cycleCheck('Test', 200_000, { failure: 'red', failedSteps: ['Run the tests'] }),
              cycleCheck('Test', 200_000, { attempt: 2, last: true, failure: 'red', failedSteps: ['Run the tests'] }),
            ],
            { red: true },
          ),
        ],
      });
      await sendPulls([twice]);

      const [window] = (await theAnswer('?period=7d')).windows;

      expect(window!.failures.steps).toEqual([{ check: 'Test', step: 'Run the tests', attempts: 2, pulls: [{ number: 1, attempts: 2 }] }]);
    });

    it("gives a check's median queue time for the window, from the rounds that recorded one", async () => {
      vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-31T12:00:00Z') });
      await sendPulls([
        queued(1, '2026-10-30T10:00:00Z', 60_000),
        queued(2, '2026-10-29T10:00:00Z', 180_000),
        queued(3, '2026-10-28T10:00:00Z', 300_000),
        // Merged before the 7-day window, inside the 30-day one.
        queued(4, '2026-10-10T10:00:00Z', 900_000),
        cyclePull(5, { mergedAt: '2026-10-27T10:00:00Z', rounds: [cycleRound([cycleCheck('Test', 1, { last: true })], { queueNotRecorded: true })] }),
      ]);

      const { windows } = await theAnswer();

      expect(windows.map((w) => [w.days, w.queue?.Test?.median, w.queue?.Test?.count])).toEqual([
        [7, 180_000, 3],
        [14, 180_000, 3],
        [30, 240_000, 4],
      ]);
    });

    it('sums the cancelled runner minutes of the pull requests in the window, against every runner minute', async () => {
      vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-31T12:00:00Z') });
      await sendPulls([
        cyclePull(1, { mergedAt: '2026-10-30T10:00:00Z', runnerMs: 600_000, cancelled: { superseded: { runs: 1, ms: 60_000 }, other: { runs: 0, ms: 0 } } }),
        cyclePull(2, { mergedAt: '2026-10-29T10:00:00Z', runnerMs: 400_000, cancelled: { superseded: { runs: 2, ms: 120_000 }, other: { runs: 1, ms: 20_000 } } }),
      ]);

      const { windows } = await theAnswer('?period=7d');

      expect(windows[0]!.cancelled).toEqual({
        superseded: { runs: 3, ms: 180_000 },
        other: { runs: 1, ms: 20_000 },
        runnerMs: 1_000_000,
        share: 0.2,
        supersededShare: 0.18,
      });
    });

    it("weighs each recorded pull request's harness against its writing, and leaves out the ones nobody timed", async () => {
      vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-31T12:00:00Z') });
      await sendPulls([
        // 300 s of checks and 300 s local against 600 s of writing: 1.
        cyclePull(1, { mergedAt: '2026-10-30T10:00:00Z' }),
        cyclePull(2, { mergedAt: '2026-10-29T10:00:00Z', codingMs: 100_000, localMs: 0, ciMs: 400_000 }),
        cyclePull(3, { mergedAt: '2026-10-28T10:00:00Z', recorded: false, codingMs: null, localMs: null }),
      ]);

      const [window] = (await theAnswer('?period=7d')).windows;

      expect(window!.pulls).toEqual({ total: 3, withRecord: 2, withoutRecord: 1 });
      expect(window!.balance.dots.map((d) => [d.number, d.ratio])).toEqual([[1, 1], [2, 4]]);
      expect(window!.balance.ratio).toMatchObject({ median: 2.5, count: 2 });
    });

    it('a check that failed and passed on a re-run is a fluke on its pull requests, and which check finished each round is named', async () => {
      vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-31T12:00:00Z') });
      const fluke = (number: number) =>
        cyclePull(number, {
          mergedAt: '2026-10-30T10:00:00Z',
          rounds: [
            cycleRound([cycleCheck('Lint', 30_000), cycleCheck('Test', 200_000, { failure: 'fluke', flukeMs: 100_000 }), cycleCheck('Test', 100_000, { attempt: 2, last: true })]),
          ],
        });
      await sendPulls([fluke(1), fluke(2)]);

      const answer = await theAnswer('?period=7d');

      expect(answer.windows[0]!.flukes).toEqual({ count: 2, pulls: 2, ms: 200_000 });
      expect(answer.windows[0]!.checks.find((c) => c.name === 'Test')).toMatchObject({ rounds: 2, flukes: 2, flukePulls: 2, last: 2, runs: 4 });
      expect(answer.pulls[0]!.rounds[0]).toMatchObject({ last: 'Test', failed: [] });
      expect(answer.pulls[0]!.flukes).toEqual([{ name: 'Test', sha: 'b'.repeat(40), ms: 100_000 }]);
    });
  });
});
