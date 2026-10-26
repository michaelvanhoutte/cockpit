import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { ciAttempt, emptyTheDatabase, failedJob, failedTest, sendAttempts, stabilityJob, stabilityStep, storedAttempts, storedFailedTests } from './support';

beforeEach(emptyTheDatabase);

const failed = (runId: number, attempt: number, over: Record<string, unknown> = {}) =>
  ciAttempt(runId, attempt, { conclusion: 'failure', outcome: 'fail', ...over });

describe('Harness Monitor', () => {
  describe('every attempt of a run of CI is stored as a row of its own, and a later send of it replaces it', () => {
    it('a run with one attempt stores that attempt with its jobs and steps', async () => {
      const response = await sendAttempts([
        ciAttempt(1, 1, {
          jobs: [
            stabilityJob('Test', 300_000, { steps: [stabilityStep('Install', 30_000), stabilityStep('Run the tests', 240_000)] }),
            stabilityJob('Lint', 60_000, { steps: [stabilityStep('Lint', 20_000)] }),
          ],
        }),
      ]);

      expect(response.status).toBe(200);
      expect(await storedAttempts()).toEqual([{ run_id: 1, attempt: 1, outcome: 'pass', jobs: 2, steps: 3, failed_jobs: 0 }]);
    });

    it('a run re-run twice stores three attempts, each with the verdict of its own', async () => {
      await sendAttempts([failed(7, 1), failed(7, 2), ciAttempt(7, 3)]);

      expect(await storedAttempts()).toEqual([
        { run_id: 7, attempt: 1, outcome: 'fail', jobs: 1, steps: 1, failed_jobs: 0 },
        { run_id: 7, attempt: 2, outcome: 'fail', jobs: 1, steps: 1, failed_jobs: 0 },
        { run_id: 7, attempt: 3, outcome: 'pass', jobs: 1, steps: 1, failed_jobs: 0 },
      ]);
    });

    it('the same attempt sent again with a later verdict is stored once, carrying the later verdict, its jobs replaced', async () => {
      await sendAttempts([
        ciAttempt(1, 1, { status: 'in_progress', conclusion: null, outcome: 'running', jobs: [stabilityJob('Test', null, { status: 'in_progress', conclusion: null, outcome: 'running' })] }),
      ]);
      await sendAttempts([
        failed(1, 1, {
          jobs: [stabilityJob('Test', 1_000, { outcome: 'fail', conclusion: 'failure' }), stabilityJob('Lint', 2_000)],
          failedJobs: [failedJob('Test', [failedTest('Triage > a dismissed item leaves the lists')])],
        }),
      ]);

      expect(await storedAttempts()).toEqual([{ run_id: 1, attempt: 1, outcome: 'fail', jobs: 2, steps: 0, failed_jobs: 1 }]);
      expect(await storedFailedTests()).toHaveLength(1);
    });

    it("an attempt sent again does not take the run's other attempts with it", async () => {
      await sendAttempts([failed(1, 1, { failedJobs: [failedJob('Test', [failedTest('a')])] }), ciAttempt(1, 2)]);
      await sendAttempts([ciAttempt(1, 2, { jobs: [] })]);

      expect(await storedAttempts()).toEqual([
        { run_id: 1, attempt: 1, outcome: 'fail', jobs: 1, steps: 1, failed_jobs: 1 },
        { run_id: 1, attempt: 2, outcome: 'pass', jobs: 0, steps: 0, failed_jobs: 0 },
      ]);
      expect(await storedFailedTests()).toHaveLength(1);
    });

    it('a failed job with two failed tests stores the job and both tests under it, a failed job with none stores its step alone', async () => {
      await sendAttempts([
        failed(1, 1, {
          failedJobs: [
            failedJob('E2E (F3)', [failedTest('Capture > a thought is kept', { file: 'tests/e2e/capture.test.ts', project: 'phone' }), failedTest('Triage > an item is dismissed', { error: null })], {
              step: 'Run pnpm test:e2e',
              testsMore: 3,
            }),
            failedJob('Lint', [], { step: 'Run pnpm lint' }),
          ],
        }),
      ]);

      expect(await storedAttempts()).toEqual([{ run_id: 1, attempt: 1, outcome: 'fail', jobs: 1, steps: 1, failed_jobs: 2 }]);
      expect(await storedFailedTests()).toEqual([
        { run_id: 1, attempt: 1, job: 'E2E (F3)', step: 'Run pnpm test:e2e', name: 'Capture > a thought is kept', project: 'phone' },
        { run_id: 1, attempt: 1, job: 'E2E (F3)', step: 'Run pnpm test:e2e', name: 'Triage > an item is dismissed', project: null },
      ]);
      const { results } = await env.DB.prepare('SELECT name, step, tests_more FROM ci_failed_jobs ORDER BY position').all();
      expect(results).toEqual([
        { name: 'E2E (F3)', step: 'Run pnpm test:e2e', tests_more: 3 },
        { name: 'Lint', step: 'Run pnpm lint', tests_more: 0 },
      ]);
    });

    it("a branch's attempt keeps its verdict and failed jobs without any job or step", async () => {
      await sendAttempts([
        failed(5, 2, {
          event: 'pull_request',
          branch: 'claude/1581-store',
          pullRequest: 1604,
          onMain: false,
          jobs: [],
          failedJobs: [failedJob('Test', [failedTest('Triage > a')])],
        }),
      ]);

      expect(await storedAttempts()).toEqual([{ run_id: 5, attempt: 2, outcome: 'fail', jobs: 0, steps: 0, failed_jobs: 1 }]);
      const { results } = await env.DB.prepare('SELECT branch, pull_number, on_main FROM ci_attempts').all();
      expect(results).toEqual([{ branch: 'claude/1581-store', pull_number: 1604, on_main: 0 }]);
    });
  });

  describe("a feature branch's attempt is stored with its branch, its pull request, its verdict and only its failures", () => {
    const onBranch = { onMain: false, jobs: [], branch: 'claude/1582-nightly' };

    it.each([
      {
        situation: "a pull request's attempt that passed",
        attempt: ciAttempt(11, 1, { ...onBranch, event: 'pull_request', pullRequest: 1604 }),
        stored: { run_id: 11, attempt: 1, outcome: 'pass', jobs: 0, steps: 0, failed_jobs: 0 },
        where: { branch: 'claude/1582-nightly', pull_number: 1604, on_main: 0 },
        tests: [],
      },
      {
        situation: "a pull request's attempt that failed",
        attempt: failed(12, 1, {
          ...onBranch,
          event: 'pull_request',
          pullRequest: 1604,
          failedJobs: [failedJob('Test', [failedTest('Triage > a dismissed item leaves the lists')])],
        }),
        stored: { run_id: 12, attempt: 1, outcome: 'fail', jobs: 0, steps: 0, failed_jobs: 1 },
        where: { branch: 'claude/1582-nightly', pull_number: 1604, on_main: 0 },
        tests: [{ run_id: 12, attempt: 1, job: 'Test', step: 'Run pnpm test', name: 'Triage > a dismissed item leaves the lists', project: null }],
      },
      {
        situation: 'a push to a branch with no pull request',
        attempt: ciAttempt(13, 1, { ...onBranch, event: 'push', pullRequest: null }),
        stored: { run_id: 13, attempt: 1, outcome: 'pass', jobs: 0, steps: 0, failed_jobs: 0 },
        where: { branch: 'claude/1582-nightly', pull_number: null, on_main: 0 },
        tests: [],
      },
    ])('$situation', async ({ attempt, stored, where, tests }) => {
      expect((await sendAttempts([attempt])).status).toBe(200);

      expect(await storedAttempts()).toEqual([stored]);
      expect((await env.DB.prepare('SELECT branch, pull_number, on_main FROM ci_attempts').all()).results).toEqual([where]);
      expect(await storedFailedTests()).toEqual(tests);
    });

    it('a later send of the attempt after its pull request closed keeps the pull request it was stored with', async () => {
      await sendAttempts([ciAttempt(14, 1, { ...onBranch, event: 'pull_request', pullRequest: 1604 })]);
      await sendAttempts([ciAttempt(14, 1, { ...onBranch, event: 'pull_request', pullRequest: null })]);

      expect((await env.DB.prepare('SELECT pull_number FROM ci_attempts').all()).results).toEqual([{ pull_number: 1604 }]);
    });

    it('a later send of an attempt stored with no pull request records the one it now has, and its verdict', async () => {
      await sendAttempts([ciAttempt(15, 1, { ...onBranch, event: 'pull_request', pullRequest: null })]);
      await sendAttempts([failed(15, 1, { ...onBranch, event: 'pull_request', pullRequest: 1604 })]);

      expect((await env.DB.prepare('SELECT pull_number, outcome FROM ci_attempts').all()).results).toEqual([{ pull_number: 1604, outcome: 'fail' }]);
    });
  });

  describe("a send of CI's attempts without the write key stores nothing", () => {
    it.each([
      { situation: 'with no key', headers: {}, status: 401 },
      { situation: 'with a wrong key', headers: { authorization: 'Bearer not-the-key' }, status: 401 },
    ])('a send $situation is refused', async ({ headers, status }) => {
      const response = await sendAttempts([ciAttempt(1)], headers);

      expect(response.status).toBe(status);
      expect(await storedAttempts()).toEqual([]);
    });
  });

  describe('a send holding any attempt of the wrong shape is refused whole, saying which and why', () => {
    it('one bad attempt among good ones stores none of the send', async () => {
      const response = await sendAttempts([
        ciAttempt(1),
        failed(7, 2, { failedJobs: [failedJob('Test', [failedTest('a'), failedTest('b', { file: '' })])] }),
        ciAttempt(3),
      ]);

      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: string }).error).toBe('Attempt 1 (run 7, attempt 2): failed job 0 (Test) test 1 has no file.');
      expect(await storedAttempts()).toEqual([]);
    });
  });

  describe('the Monitor says when its newest stored attempt started, on main or on any other branch, where the next send reads from', () => {
    it.each([
      { situation: 'main, with nothing stored', sent: [], on: 'main', newestAttempt: null },
      {
        situation: "main, with attempts stored on main and on a branch: the newest of main's",
        sent: [
          ciAttempt(1, 1, { createdAt: '2026-10-22T08:00:00Z' }),
          ciAttempt(2, 1, { createdAt: '2026-10-20T08:00:00Z' }),
          ciAttempt(3, 1, { createdAt: '2026-10-25T08:00:00Z', event: 'pull_request', branch: 'claude/x', onMain: false, jobs: [] }),
        ],
        on: 'main',
        newestAttempt: '2026-10-22T08:00:00.000Z',
      },
      {
        situation: "branches, with the same stored: the newest of the branches'",
        sent: [
          ciAttempt(1, 1, { createdAt: '2026-10-22T08:00:00Z' }),
          ciAttempt(3, 1, { createdAt: '2026-10-25T08:00:00Z', event: 'pull_request', branch: 'claude/x', onMain: false, jobs: [] }),
        ],
        on: 'branches',
        newestAttempt: '2026-10-25T08:00:00.000Z',
      },
    ])('$situation', async ({ sent, on, newestAttempt }) => {
      if (sent.length > 0) await sendAttempts(sent);

      const response = await SELF.fetch(`https://monitor.test/v1/ci-attempts?on=${on}`);

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ newestAttempt });
    });
  });
});
