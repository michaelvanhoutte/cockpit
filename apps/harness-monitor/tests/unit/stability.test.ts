import { describe, expect, it } from 'vitest';
import { checkRuns, MAX_RUNS } from '../../src/stability';

const step = (over: Record<string, unknown> = {}) => ({
  number: 1,
  name: 'Run the tests',
  occurrence: 1,
  conclusion: 'success',
  startedAt: '2026-10-01T10:00:00Z',
  completedAt: '2026-10-01T10:04:00Z',
  durationMs: 240_000,
  ...over,
});

const job = (over: Record<string, unknown> = {}) => ({
  name: 'Test',
  status: 'completed',
  conclusion: 'success',
  outcome: 'pass',
  startedAt: '2026-10-01T10:00:00Z',
  completedAt: '2026-10-01T10:05:00Z',
  durationMs: 300_000,
  failedStep: null,
  url: 'https://github.com/o/r/actions/runs/1/job/1',
  steps: [step()],
  ...over,
});

const run = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  workflow: 'CI',
  path: '.github/workflows/ci.yml',
  status: 'completed',
  conclusion: 'success',
  outcome: 'pass',
  headSha: 'a'.repeat(40),
  createdAt: '2026-10-01T10:00:00Z',
  url: `https://github.com/o/r/actions/runs/${id}`,
  jobs: [job()],
  ...over,
});

const refusal = (runs: unknown[]) => {
  const checked = checkRuns({ runs });
  return checked.ok ? null : checked.error;
};

describe('Harness Monitor', () => {
  describe("a send of CI's runs holding any run of the wrong shape, or too many runs, is refused whole, saying which and why", () => {
    it.each([
      {
        situation: 'a completed run with no conclusion',
        runs: [run(1), run(2, { conclusion: null })],
        error: 'Run 1 (2): has no conclusion, though it completed.',
      },
      {
        situation: 'a run that leaves its conclusion out',
        runs: [run(1, { conclusion: undefined })],
        error: 'Run 0 (1): has no conclusion.',
      },
      {
        situation: "a job's duration that is not a number",
        runs: [run(1, { jobs: [job(), job({ name: 'Lint', durationMs: '5 minutes' })] })],
        error: 'Run 0 (1): job 1 (Lint) has durationMs "5 minutes", which is not a whole number of milliseconds, zero or more.',
      },
      {
        situation: "a step's duration that is not a number",
        runs: [run(1, { jobs: [job({ steps: [step(), step({ name: 'Upload', durationMs: -1 })] })] })],
        error: 'Run 0 (1): job 0 (Test) step 1 (Upload) has durationMs -1, which is not a whole number of milliseconds, zero or more.',
      },
      {
        situation: 'more runs than one send takes',
        runs: Array.from({ length: MAX_RUNS + 1 }, (_, i) => run(i + 1)),
        error: `The send has ${MAX_RUNS + 1} runs; the most one send takes is ${MAX_RUNS}.`,
      },
      {
        situation: 'the same run twice',
        runs: [run(1), run(1)],
        error: 'Run 1 (1): is in the send twice.',
      },
    ])('$situation', ({ runs, error }) => {
      expect(refusal(runs)).toBe(error);
    });

    it('a run still running, with no conclusion yet, is taken', () => {
      expect(refusal([run(1, { status: 'in_progress', conclusion: null, outcome: 'running', jobs: [] })])).toBeNull();
    });
  });
});
