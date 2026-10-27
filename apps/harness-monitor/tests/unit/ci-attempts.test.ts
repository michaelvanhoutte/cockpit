import { describe, expect, it } from 'vitest';
import { checkAttempts, MAX_ATTEMPTS, MAX_FAILED_TESTS } from '../../src/ci-attempts';

const test = (over: Record<string, unknown> = {}) => ({
  file: 'tests/e2e/capture.test.ts',
  name: 'Capture > a thought is kept',
  project: 'phone',
  error: 'Error: expect(locator).toBeVisible() failed',
  ...over,
});

const failedJob = (over: Record<string, unknown> = {}) => ({
  name: 'E2E (F3)',
  step: 'Run pnpm test:e2e',
  url: 'https://github.com/o/r/actions/runs/1/job/9',
  tests: [test()],
  testsMore: 0,
  ...over,
});

const attempt = (runId: number, over: Record<string, unknown> = {}) => ({
  runId,
  attempt: 1,
  workflow: 'CI',
  path: '.github/workflows/ci.yml',
  event: 'push',
  branch: 'main',
  pullRequest: null,
  onMain: true,
  headSha: 'a'.repeat(40),
  status: 'completed',
  conclusion: 'failure',
  outcome: 'fail',
  createdAt: '2026-10-01T10:00:00Z',
  url: `https://github.com/o/r/actions/runs/${runId}`,
  jobs: [],
  failedJobs: [failedJob()],
  ...over,
});

const refusal = (attempts: unknown[]) => {
  const checked = checkAttempts({ attempts });
  return checked.ok ? null : checked.error;
};

describe('Harness Monitor', () => {
  describe("a send of CI's attempts holding any attempt of the wrong shape, or too many attempts, is refused whole, saying which and why", () => {
    it.each([
      { situation: 'a body that is not a list of attempts', body: { runs: [] }, error: 'The body must be {"attempts": [...]}.' },
      { situation: 'a send of none', body: { attempts: [] }, error: 'The send has no attempts.' },
    ])('$situation', ({ body, error }) => {
      const checked = checkAttempts(body);

      expect(checked).toEqual({ ok: false, error });
    });

    it.each([
      {
        situation: 'an attempt number that is not a whole number',
        attempts: [attempt(1), attempt(2, { attempt: 0 })],
        error: 'Attempt 1 (run 2): has attempt 0, which is not a whole number, one or more.',
      },
      {
        situation: 'an attempt that does not say whether it ran on main',
        attempts: [attempt(1, { onMain: 'yes' })],
        error: 'Attempt 0 (run 1, attempt 1): has an onMain that is not true or false.',
      },
      {
        situation: 'a pull request that is not a number',
        attempts: [attempt(1, { pullRequest: '1604' })],
        error: 'Attempt 0 (run 1, attempt 1): has pullRequest "1604", which is not a whole number, one or more.',
      },
      {
        situation: 'a completed attempt with no conclusion',
        attempts: [attempt(1, { conclusion: null })],
        error: 'Attempt 0 (run 1, attempt 1): has no conclusion, though it completed.',
      },
      {
        situation: 'an outcome the Monitor does not know',
        attempts: [attempt(1, { outcome: 'flaky' })],
        error: 'Attempt 0 (run 1, attempt 1): has outcome "flaky", which is not one of pass, fail, cancelled, skipped, running, other, unknown.',
      },
      {
        situation: 'a job of the attempt with a duration that is not a number',
        attempts: [attempt(1, { jobs: [{ name: 'Test', status: 'completed', conclusion: 'success', outcome: 'pass', durationMs: 'long', steps: [] }] })],
        error: 'Attempt 0 (run 1, attempt 1): job 0 (Test) has durationMs "long", which is not a whole number of milliseconds, zero or more.',
      },
      {
        situation: 'a failed job with no list of tests',
        attempts: [attempt(1, { failedJobs: [failedJob({ tests: undefined })] })],
        error: 'Attempt 0 (run 1, attempt 1): failed job 0 (E2E (F3)) has no list of tests.',
      },
      {
        situation: 'a failed job whose count of unnamed tests is negative',
        attempts: [attempt(1, { failedJobs: [failedJob({ testsMore: -1 })] })],
        error: 'Attempt 0 (run 1, attempt 1): failed job 0 (E2E (F3)) has testsMore -1, which is not a whole number, zero or more.',
      },
      {
        situation: 'a failed test with no name',
        attempts: [attempt(1, { failedJobs: [failedJob(), failedJob({ name: 'Test', tests: [test(), test({ name: '' })] })] })],
        error: 'Attempt 0 (run 1, attempt 1): failed job 1 (Test) test 1 has no name.',
      },
      {
        situation: 'a failed test with an error that is not text',
        attempts: [attempt(1, { failedJobs: [failedJob({ tests: [test({ error: 5 })] })] })],
        error: 'Attempt 0 (run 1, attempt 1): failed job 0 (E2E (F3)) test 0 has an error that is not a short string.',
      },
      {
        situation: 'more failed tests under one job than a record names',
        attempts: [attempt(1, { failedJobs: [failedJob({ tests: Array.from({ length: MAX_FAILED_TESTS + 1 }, () => test()) })] })],
        error: `Attempt 0 (run 1, attempt 1): failed job 0 (E2E (F3)) has ${MAX_FAILED_TESTS + 1} tests; the most one failed job takes is ${MAX_FAILED_TESTS}.`,
      },
      {
        situation: 'more attempts than one send takes',
        attempts: Array.from({ length: MAX_ATTEMPTS + 1 }, (_, i) => attempt(i + 1)),
        error: `The send has ${MAX_ATTEMPTS + 1} attempts; the most one send takes is ${MAX_ATTEMPTS}.`,
      },
      {
        situation: 'the same attempt twice',
        attempts: [attempt(1), attempt(1)],
        error: 'Attempt 1 (run 1, attempt 1): is in the send twice.',
      },
    ])('$situation', ({ attempts, error }) => {
      expect(refusal(attempts)).toBe(error);
    });

    it('two attempts of one run, and a failed test with no error or project, are taken', () => {
      expect(refusal([attempt(1), attempt(1, { attempt: 2 }), attempt(2, { failedJobs: [failedJob({ tests: [test({ error: null, project: null })] })] })])).toBeNull();
    });

    it('a failed job that kept no record, with its step and no tests, is taken', () => {
      expect(refusal([attempt(1, { failedJobs: [failedJob({ tests: [], step: null })] })])).toBeNull();
    });
  });
});
