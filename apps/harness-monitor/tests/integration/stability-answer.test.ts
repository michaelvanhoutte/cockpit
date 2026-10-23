import { SELF } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyTheDatabase, sendRuns, stabilityJob, stabilityRun, stabilityStep } from './support';

beforeEach(emptyTheDatabase);
afterEach(() => vi.useRealTimers());

const theAnswer = async (query = '') => {
  const response = await SELF.fetch(`https://monitor.test/stability${query}`);
  expect(response.status).toBe(200);
  return response.json();
};

/** A run whose Test job took `seconds`, its one step half of that, started at `createdAt`. */
const testRun = (id: number, createdAt: string, seconds: number, over: Record<string, unknown> = {}) =>
  stabilityRun(id, {
    createdAt,
    jobs: [stabilityJob('Test', seconds * 1000, { steps: [stabilityStep('Run the tests', seconds * 500)], ...over })],
  });

describe('Harness Monitor', () => {
  describe("CI stability's stored runs answer for the period asked, as JSON", () => {
    it('with nothing stored, the answer is empty and names the period', async () => {
      vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-31T12:00:00Z') });

      expect(await theAnswer()).toEqual({
        period: '30d',
        firstDay: '2026-10-02',
        windows: [
          { days: 7, firstDay: '2026-10-25', runs: 0, workflows: [] },
          { days: 30, firstDay: '2026-10-02', runs: 0, workflows: [] },
        ],
      });
    });

    it("counts only the runs from the start of the period's first Belgian day", async () => {
      vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-20T12:00:00Z') });
      // 14 Oct begins in Brussels at 22:00 UTC on the 13th.
      await sendRuns([testRun(1, '2026-10-13T21:59:00Z', 100), testRun(2, '2026-10-13T22:00:00Z', 200)]);

      const answer = await theAnswer('?period=7d');

      expect(answer).toEqual({
        period: '7d',
        firstDay: '2026-10-14',
        windows: [
          {
            days: 7,
            firstDay: '2026-10-14',
            runs: 1,
            workflows: [
              {
                name: 'CI',
                jobs: [
                  {
                    name: 'Test',
                    durations: { median: 200_000, p90: 200_000, count: 1 },
                    steps: [{ name: 'Run the tests', occurrence: 1, durations: { median: 100_000, p90: 100_000, count: 1 } }],
                  },
                ],
              },
            ],
          },
        ],
      });
    });

    it("gives a job's median and p90 per window, and each step's, counting only what passed or failed", async () => {
      vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-31T12:00:00Z') });
      await sendRuns([
        testRun(1, '2026-10-30T10:00:00Z', 100),
        testRun(2, '2026-10-29T10:00:00Z', 200, { conclusion: 'failure', outcome: 'fail' }),
        testRun(3, '2026-10-28T10:00:00Z', 300),
        testRun(4, '2026-10-27T10:00:00Z', 9_999, { conclusion: 'cancelled', outcome: 'cancelled' }),
        testRun(5, '2026-10-10T10:00:00Z', 400),
        testRun(6, '2026-10-09T10:00:00Z', 500),
        stabilityRun(7, {
          createdAt: '2026-10-08T10:00:00Z',
          jobs: [stabilityJob('Test', null, { steps: [stabilityStep('Run the tests', null, { conclusion: 'skipped' })] })],
        }),
      ]);

      const answer = (await theAnswer()) as {
        windows: { days: number; runs: number; workflows: { jobs: { name: string; durations: unknown; steps: unknown[] }[] }[] }[];
      };

      expect(answer.windows.map((w) => ({ days: w.days, runs: w.runs, test: w.workflows[0]!.jobs[0] }))).toEqual([
        {
          days: 7,
          runs: 4,
          test: {
            name: 'Test',
            durations: { median: 200_000, p90: 300_000, count: 3 },
            steps: [{ name: 'Run the tests', occurrence: 1, durations: { median: 100_000, p90: 150_000, count: 3 } }],
          },
        },
        {
          days: 30,
          runs: 7,
          test: {
            name: 'Test',
            durations: { median: 300_000, p90: 500_000, count: 5 },
            steps: [{ name: 'Run the tests', occurrence: 1, durations: { median: 150_000, p90: 250_000, count: 5 } }],
          },
        },
      ]);
    });

    it('lists the steps of a job in the order it runs them, each repeated name apart', async () => {
      vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-31T12:00:00Z') });
      const steps = [stabilityStep('Upload', 2_000), stabilityStep('Install', 30_000), stabilityStep('Upload', 4_000, { occurrence: 2 })];
      await sendRuns([stabilityRun(1, { createdAt: '2026-10-30T10:00:00Z', jobs: [stabilityJob('Test', 60_000, { steps })] })]);

      const answer = (await theAnswer('?period=7d')) as { windows: { workflows: { jobs: { steps: { name: string; occurrence: number }[] }[] }[] }[] };

      expect(answer.windows[0]!.workflows[0]!.jobs[0]!.steps.map((s) => `${s.name} ${s.occurrence}`)).toEqual(['Upload 1', 'Install 1', 'Upload 2']);
    });
  });
});
