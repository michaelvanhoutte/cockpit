import { describe, expect, it } from 'vitest';

import { attemptRows, failedTestsOf, isDependabot, onMainOf, recordArtifactFor } from '../../src/model.js';

const run = (overrides = {}) => ({
  id: 1,
  workflow: 'CI',
  path: '.github/workflows/ci.yml',
  event: 'push',
  branch: 'main',
  pullRequest: null,
  conclusion: 'failure',
  status: 'completed',
  headSha: 'deadbeef1234',
  createdAt: '2026-10-20T08:00:00Z',
  startedAt: '2026-10-20T08:00:00Z',
  attempt: 1,
  url: 'https://github.com/o/r/actions/runs/1',
  ...overrides,
});

const job = (name, conclusion, overrides = {}) => ({
  runId: 1,
  name,
  conclusion,
  status: 'completed',
  startedAt: '2026-10-20T08:01:00Z',
  completedAt: '2026-10-20T08:11:00Z',
  failedStep: conclusion === 'failure' ? 'Run the tests' : null,
  steps: [],
  url: `https://github.com/o/r/actions/runs/1/job/${name.length}`,
  ...overrides,
});

const read = (failedTests, failedTestsMore = 0) => ({ state: 'read', value: { failedTests, failedTestsMore } });
const test = (name, overrides = {}) => ({ file: 'tests/e2e/capture.test.ts', name, project: 'phone', error: 'Error: expected visible', ...overrides });

/** The one attempt of `run` with `jobs`, as `collectAttempts` hands it over. */
const rowOf = (jobs, runOverrides = {}, attempt = 1) => attemptRows([{ run: run(runOverrides), attempt, jobs }])[0];

describe('CI stability', () => {
  describe("an attempt's verdict and failed jobs are decided before it is sent", () => {
    it('a shard of E2E that fails with tests, and the fan-in failing after it, are one failed job with the shard\'s tests', () => {
      const row = rowOf([
        job('Lint', 'success'),
        job('E2E (F3) (1)', 'success'),
        job('E2E (F3) (2)', 'failure', { failedStep: 'Run pnpm test:e2e', url: 'https://github.com/o/r/actions/runs/1/job/22' }),
        job('E2E (F3)', 'failure', { failedStep: 'Fail if a shard failed', record: read([test('Capture > a thought is kept'), test('Triage > an item is dismissed')]) }),
      ]);

      expect(row.outcome).toBe('fail');
      expect(row.failedJobs).toEqual([
        {
          name: 'E2E (F3)',
          step: 'Run pnpm test:e2e',
          url: 'https://github.com/o/r/actions/runs/1/job/22',
          tests: [
            { file: 'tests/e2e/capture.test.ts', name: 'Capture > a thought is kept', project: 'phone', error: 'Error: expected visible' },
            { file: 'tests/e2e/capture.test.ts', name: 'Triage > an item is dismissed', project: 'phone', error: 'Error: expected visible' },
          ],
          testsMore: 0,
        },
      ]);
      expect(row.jobs.map((each) => each.name)).toEqual(['Lint', 'E2E (F3)']);
    });

    it('the fan-in failing on its own, every shard passing, is the failed job, with its own step', () => {
      const row = rowOf([job('E2E (F3) (1)', 'success'), job('E2E (F3) (2)', 'success'), job('E2E (F3)', 'failure', { failedStep: 'Merge the shards\' records' })]);

      expect(row.failedJobs.map((each) => [each.name, each.step, each.tests])).toEqual([['E2E (F3)', "Merge the shards' records", []]]);
    });

    it('a fan-in skipped behind a failed shard still leaves the one failed job, with no tests to name', () => {
      const row = rowOf([job('E2E (F3) (1)', 'failure'), job('E2E (F3)', 'skipped', { failedStep: null })]);

      expect(row.failedJobs.map((each) => [each.name, each.step, each.tests])).toEqual([['E2E (F3)', 'Run the tests', []]]);
    });

    it.each([
      { situation: 'a record that names no test', record: read([]), tests: [], more: 0 },
      { situation: 'a record from before records named tests', record: { state: 'read', value: { packages: [] } }, tests: [], more: 0 },
      { situation: 'no record at all', record: undefined, tests: [], more: 0 },
      { situation: 'a record that expired', record: { state: 'not-recorded', why: 'expired' }, tests: [], more: 0 },
      { situation: 'a record that could not be read', record: { state: 'not-recorded', why: 'unreadable' }, tests: [], more: 0 },
    ])('a failed job with $situation is the job with its failed step and no tests', ({ record, tests, more }) => {
      const row = rowOf([job('Test', 'failure', { record })]);

      expect(row.failedJobs).toEqual([{ name: 'Test', step: 'Run the tests', url: expect.any(String), tests, testsMore: more }]);
    });

    it('a record naming more tests than it lists carries the count it left out', () => {
      const row = rowOf([job('Test', 'failure', { record: read([test('a')], 7) })]);

      expect(row.failedJobs[0]).toMatchObject({ tests: [expect.objectContaining({ name: 'a' })], testsMore: 7 });
    });

    it('a test of no file or no name is left out of what is sent, not sent to be refused', () => {
      expect(failedTestsOf(read([test('kept'), test('', {}), test('no file', { file: '' }), { name: 'bare' }]))).toEqual({
        tests: [expect.objectContaining({ name: 'kept' })],
        testsMore: 0,
      });
    });

    it.each([
      { situation: 'a Dependabot run named for its update', over: { path: 'dynamic/dependabot/dependabot-updates', event: 'dynamic', workflow: 'npm_and_yarn in /. for esbuild - Update #1547810405' } },
      { situation: 'another named for a different update', over: { path: 'dynamic/dependabot/dependabot-updates', event: 'dynamic', workflow: 'github_actions in / for actions/checkout - Update #1547810999' } },
    ])('$situation is filed under the workflow Dependabot', ({ over }) => {
      const row = rowOf([], { conclusion: 'success', ...over });

      expect(row.workflow).toBe('Dependabot');
      expect(row.outcome).toBe('pass');
    });

    it('a Dependabot run with no workflow file still has a path to send', () => {
      const row = rowOf([], { conclusion: 'success', path: null, event: 'dynamic', workflow: 'npm_and_yarn in /. for esbuild - Update #1547810405' });

      expect(row.workflow).toBe('Dependabot');
      expect(row.path).toBe('dynamic/dependabot');
    });

    it('a workflow of the repository keeps its own name', () => {
      expect(rowOf([], { workflow: 'Stability backfill' }).workflow).toBe('Stability backfill');
      expect(isDependabot(run())).toBe(false);
    });

    it('an earlier attempt whose own jobs passed has the verdict pass, though the run it belongs to failed', () => {
      const [first, second] = attemptRows([
        { run: run({ conclusion: 'failure', attempt: 2 }), attempt: 1, jobs: [job('Test', 'success'), job('Lint', 'skipped')] },
        { run: run({ conclusion: 'failure', attempt: 2 }), attempt: 2, jobs: [job('Test', 'failure')] },
      ]);

      expect([first.outcome, first.conclusion, first.status]).toEqual(['pass', 'success', 'completed']);
      expect(first.failedJobs).toEqual([]);
      expect([second.outcome, second.failedJobs.map((each) => each.name)]).toEqual(['fail', ['Test']]);
    });

    it.each([
      { situation: 'a failed job among passed ones', jobs: [job('Test', 'success'), job('Lint', 'failure')], outcome: 'fail', conclusion: 'failure' },
      { situation: 'a job that timed out', jobs: [job('Test', 'timed_out')], outcome: 'fail', conclusion: 'timed_out' },
      { situation: 'a cancelled job among passed ones', jobs: [job('Test', 'success'), job('Lint', 'cancelled')], outcome: 'cancelled', conclusion: 'cancelled' },
      { situation: 'every job skipped', jobs: [job('Test', 'skipped')], outcome: 'skipped', conclusion: 'skipped' },
      { situation: 'a job of a conclusion nobody knows', jobs: [job('Test', 'surprising')], outcome: 'unknown', conclusion: 'surprising' },
      { situation: 'no job to read', jobs: [], outcome: 'unknown', conclusion: null },
    ])('an earlier attempt with $situation reads as $outcome', ({ jobs, outcome, conclusion }) => {
      const row = rowOf(jobs, { attempt: 2 }, 1);

      expect([row.outcome, row.conclusion]).toEqual([outcome, conclusion]);
    });

    it('the latest attempt takes the run\'s own verdict, and an earlier one starts when its first job did and links to its own page', () => {
      const [first, latest] = attemptRows([
        { run: run({ attempt: 2, startedAt: '2026-10-20T09:30:00Z' }), attempt: 1, jobs: [job('Test', 'failure', { startedAt: '2026-10-20T08:02:00Z' }), job('Lint', 'success', { startedAt: '2026-10-20T08:01:00Z' })] },
        { run: run({ attempt: 2, startedAt: '2026-10-20T09:30:00Z', conclusion: 'success' }), attempt: 2, jobs: [job('Test', 'success')] },
      ]);

      expect([first.createdAt, first.url]).toEqual(['2026-10-20T08:01:00Z', 'https://github.com/o/r/actions/runs/1/attempts/1']);
      expect([latest.outcome, latest.createdAt, latest.url]).toEqual(['pass', '2026-10-20T09:30:00Z', 'https://github.com/o/r/actions/runs/1']);
    });
  });

  describe('an attempt keeps the branch and pull request it ran for, and the jobs of main\'s alone', () => {
    it.each([
      { situation: 'a push to main', run: { event: 'push', branch: 'main' }, onMain: true },
      { situation: 'a scheduled run', run: { event: 'schedule', branch: 'main' }, onMain: true },
      { situation: 'a manual run', run: { event: 'workflow_dispatch', branch: 'main' }, onMain: true },
      { situation: 'a pull request\'s run', run: { event: 'pull_request', branch: 'claude/1581-store', pullRequest: 1604 }, onMain: false },
      { situation: 'a push to another branch', run: { event: 'push', branch: 'claude/1581-store' }, onMain: false },
      { situation: 'a manual run on another branch', run: { event: 'workflow_dispatch', branch: 'claude/1581-store' }, onMain: false },
      { situation: 'a merge queue\'s run', run: { event: 'merge_group', branch: 'gh-readonly-queue/main/pr-1604' }, onMain: false },
    ])('$situation is main\'s: $onMain', ({ run: over, onMain }) => {
      const row = rowOf([job('Test', 'failure', { record: read([test('a')]) })], over);

      expect(row.onMain).toBe(onMain);
      expect(row.branch).toBe(over.branch);
      expect(row.pullRequest).toBe(over.pullRequest ?? null);
      expect(row.jobs.length).toBe(onMain ? 1 : 0);
      // A branch's failed jobs and their tests are kept whichever way it ran.
      expect(row.failedJobs[0].tests).toHaveLength(1);
      expect(onMainOf(over)).toBe(onMain);
    });
  });

  describe('which jobs keep a record naming their failed tests', () => {
    it.each([
      { path: '.github/workflows/ci.yml', job: 'Test', artifact: 'test-selection-record' },
      { path: '.github/workflows/ci.yml', job: 'E2E (F3)', artifact: 'e2e-selection-record' },
      { path: '.github/workflows/ci.yml', job: 'Lint', artifact: null },
      { path: '.github/workflows/ci.yml', job: 'toString', artifact: null },
      { path: '.github/workflows/deploy-staging.yml', job: 'Staging', artifact: 'failed-tests-record' },
      { path: '.github/workflows/deploy-production.yml', job: 'Production', artifact: 'failed-tests-record' },
      { path: '.github/workflows/contract.yml', job: 'Contract tests', artifact: 'failed-tests-record' },
      { path: '.github/workflows/nightly.yml', job: 'Test', artifact: null },
      { path: 'dynamic/dependabot/dependabot-updates', job: 'dependabot', artifact: null },
    ])('$job in $path uploads $artifact', ({ path, job: name, artifact }) => {
      expect(recordArtifactFor(path, name)).toBe(artifact);
    });
  });
});
