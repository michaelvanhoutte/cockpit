import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { emptyTheDatabase, sendRuns, stabilityJob, stabilityRun, stabilityStep, storedRuns } from './support';

beforeEach(emptyTheDatabase);

/** Three runs, each with two jobs of two steps. */
const threeRuns = (over: Record<string, unknown> = {}) =>
  [1, 2, 3].map((id) =>
    stabilityRun(id, {
      jobs: [
        stabilityJob('Test', 300_000, { steps: [stabilityStep('Install', 30_000), stabilityStep('Run the tests', 240_000)] }),
        stabilityJob('Lint', 60_000, { steps: [stabilityStep('Install', 30_000), stabilityStep('Lint', 20_000)] }),
      ],
      ...over,
    }),
  );

describe('Harness Monitor', () => {
  describe('a run of CI sent to the Monitor is stored once, with its jobs and steps, and a later send of it replaces it', () => {
    it('a first send of three runs stores each with its jobs and steps', async () => {
      const response = await sendRuns(threeRuns());

      expect(response.status).toBe(200);
      expect(await storedRuns()).toEqual([1, 2, 3].map((run_id) => ({ run_id, conclusion: 'success', jobs: 2, steps: 4 })));
    });

    it('the same send again doubles nothing', async () => {
      await sendRuns(threeRuns());
      await sendRuns(threeRuns());

      expect(await storedRuns()).toEqual([1, 2, 3].map((run_id) => ({ run_id, conclusion: 'success', jobs: 2, steps: 4 })));
    });

    it("a run re-sent after a re-run carries the re-run's later verdict", async () => {
      await sendRuns([stabilityRun(1, { conclusion: 'failure', outcome: 'fail' })]);
      await sendRuns([stabilityRun(1, { conclusion: 'success', outcome: 'pass' })]);

      expect(await storedRuns()).toEqual([{ run_id: 1, conclusion: 'success', jobs: 1, steps: 1 }]);
    });

    it("two overlapping sends, a merge's and the next one's, store each run once with the later send's values", async () => {
      await sendRuns([stabilityRun(1), stabilityRun(2, { status: 'in_progress', conclusion: null, outcome: 'running', jobs: [] })]);
      await sendRuns([stabilityRun(2, { conclusion: 'failure', outcome: 'fail' }), stabilityRun(3)]);

      expect(await storedRuns()).toEqual([
        { run_id: 1, conclusion: 'success', jobs: 1, steps: 1 },
        { run_id: 2, conclusion: 'failure', jobs: 1, steps: 1 },
        { run_id: 3, conclusion: 'success', jobs: 1, steps: 1 },
      ]);
    });
  });

  describe("a send of CI's runs without the write key stores nothing", () => {
    it.each([
      { situation: 'with no key', headers: {}, status: 401 },
      { situation: 'with a wrong key', headers: { authorization: 'Bearer not-the-key' }, status: 401 },
    ])('a send $situation is refused', async ({ headers, status }) => {
      const response = await sendRuns(threeRuns(), headers);

      expect(response.status).toBe(status);
      expect(await storedRuns()).toEqual([]);
    });

    it('with no key set on the Monitor, a send is refused even carrying one', async () => {
      const configured = env.HARNESS_WRITE_KEY;
      delete env.HARNESS_WRITE_KEY;
      try {
        const response = await sendRuns(threeRuns());

        expect(response.status).toBe(503);
        expect(await storedRuns()).toEqual([]);
      } finally {
        if (configured !== undefined) env.HARNESS_WRITE_KEY = configured;
      }
    });
  });

  describe('a send holding any run of the wrong shape is refused whole, saying which and why', () => {
    it('one bad run among good ones stores none of the send', async () => {
      const [first, , third] = threeRuns();
      const response = await sendRuns([first, stabilityRun(7, { jobs: [stabilityJob('Test', 'long' as unknown as number)] }), third]);

      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: string }).error).toMatch(/^Run 1 \(7\): job 0 \(Test\) has durationMs "long"/);
      expect(await storedRuns()).toEqual([]);
    });
  });

  describe('the Monitor says when its newest stored run started, where the next send reads from', () => {
    it.each([
      { situation: 'with nothing stored', sent: [], newestRun: null },
      {
        situation: 'with runs stored',
        sent: [stabilityRun(1, { createdAt: '2026-10-22T08:00:00Z' }), stabilityRun(2, { createdAt: '2026-10-20T08:00:00Z' })],
        newestRun: '2026-10-22T08:00:00.000Z',
      },
    ])('$situation', async ({ sent, newestRun }) => {
      if (sent.length > 0) await sendRuns(sent);

      const response = await SELF.fetch('https://monitor.test/v1/stability');

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ newestRun });
    });
  });
});
