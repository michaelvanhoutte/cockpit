import { describe, expect, it } from 'vitest';
import { causesOf, flakyAmong, periodDays, sortFigures, whereOf, workflowFigures, workflowPrompt, type Attempt, type FailedJob } from '../../src/ci-flakiness';

const MINUTE = 60_000;
const at = (minutes: number) => Date.UTC(2026, 9, 20, 10, 0) + minutes * MINUTE;

let next = 0;
/** An attempt of CI on main that passed, started `minutes` after 10:00 on 20 Oct, unless told otherwise. */
const attempt = (over: Partial<Attempt> & { minutes?: number } = {}): Attempt => {
  const { minutes = 0, ...rest } = over;
  next++;
  return { runId: next, attempt: 1, workflow: 'CI', event: 'push', branch: 'main', pull: null, onMain: true, sha: 'a', outcome: 'pass', at: at(minutes), url: `https://github.com/o/r/actions/runs/${next}`, failedJobs: [], ...rest };
};
const onBranch = { onMain: false, event: 'pull_request', branch: 'claude/1584-workflow-tab', pull: 1604 };
const failing = (over: Partial<Attempt> & { minutes?: number } = {}) => attempt({ outcome: 'fail', ...over });
const job = (name: string, tests: string[] = [], step: string | null = 'Run pnpm test'): FailedJob => ({
  name,
  step,
  url: `https://github.com/o/r/actions/runs/1/job/${name.length}`,
  tests: tests.map((t) => ({ file: 'apps/api/tests/integration/triage.test.ts', name: t, project: null, error: 'AssertionError: expected 1 to be 2' })),
});

describe('Harness Monitor', () => {
  describe('a failure counts on main always, and on a feature branch only once a later attempt on the same commit passed', () => {
    it.each([
      { situation: 'a run on main that failed and was never re-run', attempts: [failing()], failedOnMain: 1, flakyOnMain: 0, flakyOnBranches: 0 },
      { situation: 'a run on main that failed, then passed on a re-run', attempts: [failing(), attempt({ attempt: 2, minutes: 5 })], failedOnMain: 1, flakyOnMain: 1, flakyOnBranches: 0 },
      { situation: 'a scheduled run that failed', attempts: [failing({ event: 'schedule' })], failedOnMain: 1, flakyOnMain: 0, flakyOnBranches: 0 },
      { situation: 'a manual run that failed', attempts: [failing({ event: 'workflow_dispatch' })], failedOnMain: 1, flakyOnMain: 0, flakyOnBranches: 0 },
      { situation: "a pull request's attempt that failed, then passed on a re-run", attempts: [failing(onBranch), attempt({ ...onBranch, attempt: 2, minutes: 5 })], failedOnMain: 0, flakyOnMain: 0, flakyOnBranches: 1 },
      { situation: "a pull request's attempt that failed and a later commit passed instead", attempts: [failing(onBranch), attempt({ ...onBranch, sha: 'b', minutes: 5 })], failedOnMain: 0, flakyOnMain: 0, flakyOnBranches: 0 },
      { situation: "a pull request's attempt that failed and was never re-run", attempts: [failing(onBranch)], failedOnMain: 0, flakyOnMain: 0, flakyOnBranches: 0 },
      { situation: 'the same commit failing twice on a pull request, then passing', attempts: [failing(onBranch), failing({ ...onBranch, attempt: 2, minutes: 5 }), attempt({ ...onBranch, attempt: 3, minutes: 10 })], failedOnMain: 0, flakyOnMain: 0, flakyOnBranches: 2 },
      { situation: 'the same commit failing twice on main, then passing', attempts: [failing(), failing({ attempt: 2, minutes: 5 }), attempt({ attempt: 3, minutes: 10 })], failedOnMain: 2, flakyOnMain: 2, flakyOnBranches: 0 },
      { situation: 'the same commit failing twice on main and never passing', attempts: [failing(), failing({ attempt: 2, minutes: 5 })], failedOnMain: 2, flakyOnMain: 0, flakyOnBranches: 0 },
      { situation: 'the same commit failing twice on a pull request and never passing', attempts: [failing(onBranch), failing({ ...onBranch, attempt: 2, minutes: 5 })], failedOnMain: 0, flakyOnMain: 0, flakyOnBranches: 0 },
      { situation: 'a pass that came before the failure', attempts: [attempt(), failing({ minutes: 5 })], failedOnMain: 1, flakyOnMain: 0, flakyOnBranches: 0 },
      { situation: "a failure on main that a pull request's run of the same commit passed", attempts: [failing(), attempt({ ...onBranch, minutes: 5 })], failedOnMain: 1, flakyOnMain: 0, flakyOnBranches: 0 },
      { situation: "another workflow's pass on the same commit", attempts: [failing(), attempt({ workflow: 'Nightly', minutes: 5 })], failedOnMain: 1, flakyOnMain: 0, flakyOnBranches: 0 },
    ])('$situation', ({ attempts, failedOnMain, flakyOnMain, flakyOnBranches }) => {
      const figures = workflowFigures('CI', attempts, flakyAmong(attempts));

      expect([figures.failed.length, figures.mainFlaky, figures.branchFlaky.length]).toEqual([failedOnMain, flakyOnMain, flakyOnBranches]);
    });

    it('a pass rate is main passed against main passed and failed, and a workflow with no run on main has none', () => {
      const attempts = [attempt(), attempt({ sha: 'b', minutes: 5 }), failing({ sha: 'c', minutes: 10 }), failing({ ...onBranch, sha: 'd' })];

      expect(workflowFigures('CI', attempts, flakyAmong(attempts)).rate).toBeCloseTo(2 / 3);
      expect(workflowFigures('CI', [failing({ ...onBranch }), attempt({ ...onBranch, attempt: 2, minutes: 1 })], new Set()).rate).toBeNull();
    });
  });

  describe('a cause is the failing test where the attempt names one, otherwise the job and step', () => {
    const flakyOf = (attempts: Attempt[]) => flakyAmong(attempts);

    it('one test failing in many attempts is one cause, its count on main and on branches apart', () => {
      const failed = [
        failing({ failedJobs: [job('Test', ['a dismissed item leaves the lists'])] }),
        failing({ minutes: 5, sha: 'b', failedJobs: [job('Test', ['a dismissed item leaves the lists'])] }),
        failing({ ...onBranch, failedJobs: [job('Test', ['a dismissed item leaves the lists'])] }),
        attempt({ ...onBranch, attempt: 2, minutes: 3 }),
      ];

      const causes = causesOf(failed.filter((a) => a.outcome === 'fail'), flakyOf(failed));

      expect(causes.map((c) => [c.label, c.main, c.branch])).toEqual([['a dismissed item leaves the lists', 2, 1]]);
    });

    it('a failed job naming two tests is two causes, one each', () => {
      const failed = [failing({ failedJobs: [job('Test', ['first', 'second'])] })];

      expect(causesOf(failed, new Set()).map((c) => [c.label, c.kind, c.main])).toEqual([
        ['first', 'test', 1],
        ['second', 'test', 1],
      ]);
    });

    it('a failed job naming no test is a cause of its job and step', () => {
      const [cause] = causesOf([failing({ failedJobs: [job('Lint', [], 'Run pnpm lint')] })], new Set());

      expect(cause).toMatchObject({ label: 'Lint · Run pnpm lint', kind: 'step', sub: 'no test named', main: 1 });
    });

    it('a failed job naming no step says so', () => {
      expect(causesOf([failing({ failedJobs: [job('Lint', [], null)] })], new Set())[0]!.label).toBe('Lint · no failing step');
    });

    it('an attempt with no failed job recorded is a cause saying none was recorded', () => {
      const [cause] = causesOf([failing()], new Set());

      expect(cause).toMatchObject({ label: 'No failed job recorded', kind: 'unknown', main: 1 });
    });

    it('a test failing in two projects of one attempt counts that attempt once', () => {
      const twice = failing({ failedJobs: [job('E2E (F3)', ['a thought is kept', 'a thought is kept'])] });

      expect(causesOf([twice], new Set())[0]).toMatchObject({ main: 1, runs: [expect.anything()] });
    });

    it('lists main\'s causes first, most first, then those only branches have', () => {
      const failed = [
        failing({ failedJobs: [job('Test', ['rare'])] }),
        failing({ sha: 'b', minutes: 5, failedJobs: [job('Test', ['common'])] }),
        failing({ sha: 'c', minutes: 6, failedJobs: [job('Test', ['common'])] }),
        failing({ ...onBranch, sha: 'd', minutes: 7, failedJobs: [job('Test', ['branch only'])] }),
        failing({ ...onBranch, sha: 'e', minutes: 8, failedJobs: [job('Test', ['branch only', 'rare'])] }),
      ];

      expect(causesOf(failed, new Set(failed)).map((c) => [c.label, c.main, c.branch])).toEqual([
        ['common', 2, 0],
        ['rare', 1, 1],
        ['branch only', 0, 2],
      ]);
    });

    it('keeps the error and the link of the newest failure of a cause', () => {
      const old = failing({ failedJobs: [{ ...job('Test', ['x']), url: 'https://github.com/o/r/actions/runs/1/job/1' }] });
      const recent = failing({ minutes: 9, sha: 'b', failedJobs: [{ ...job('Test', ['x']), url: 'https://github.com/o/r/actions/runs/2/job/2', tests: [{ file: 'f.test.ts', name: 'x', project: null, error: 'Timeout 5000ms' }] }] });

      expect(causesOf([recent, old], new Set())[0]).toMatchObject({ lastUrl: 'https://github.com/o/r/actions/runs/2/job/2', error: 'Timeout 5000ms' });
    });
  });

  describe('workflows are ranked by main, and each failure says where it ran', () => {
    const rows = () => {
      const attempts = [
        attempt({ workflow: 'Steady' }),
        failing({ workflow: 'Flaky', minutes: 1 }),
        failing({ workflow: 'Flaky', sha: 'b', minutes: 2 }),
        attempt({ workflow: 'Flaky', sha: 'c', minutes: 3 }),
        failing({ workflow: 'Breaks', sha: 'd', minutes: 4 }),
        failing({ workflow: 'Breaks', sha: 'e', minutes: 5 }),
        failing({ workflow: 'Breaks', sha: 'f', minutes: 6 }),
        failing({ ...onBranch, workflow: 'Only branches' }),
        attempt({ ...onBranch, workflow: 'Only branches', attempt: 2, minutes: 1 }),
      ];
      const flaky = flakyAmong(attempts);
      return ['Steady', 'Flaky', 'Breaks', 'Only branches'].map((name) => workflowFigures(name, attempts, flaky));
    };

    it.each([
      { situation: 'least reliable first, a workflow with no run on main last', sort: 'worst', expected: ['Breaks', 'Flaky', 'Steady', 'Only branches'] },
      { situation: 'most failures on main first, then branch flakes', sort: 'failures', expected: ['Breaks', 'Flaky', 'Only branches', 'Steady'] },
    ])('$situation', ({ sort, expected }) => {
      expect(sortFigures(rows(), sort).map((r) => r.name)).toEqual(expected);
    });

    it.each([
      { situation: 'a push to main', a: attempt(), expected: 'main' },
      { situation: 'a scheduled run', a: attempt({ event: 'schedule' }), expected: 'schedule' },
      { situation: 'a manual run', a: attempt({ event: 'workflow_dispatch' }), expected: 'workflow dispatch' },
      { situation: 'a pull request', a: attempt(onBranch), expected: 'pull request 1604' },
      { situation: 'a branch whose pull request has closed', a: attempt({ ...onBranch, pull: null }), expected: 'claude/1584-workflow-tab' },
    ])('$situation reads $expected', ({ a, expected }) => {
      expect(whereOf(a)).toBe(expected);
    });
  });

  describe('a period covers the days it names, and everything held runs from the oldest attempt', () => {
    const now = Date.UTC(2026, 9, 31, 12, 0);

    it.each([
      { situation: 'the last 7 days', period: '7d' as const, oldest: null, first: '2026-10-25', count: 7 },
      { situation: 'the last 30 days', period: '30d' as const, oldest: null, first: '2026-10-02', count: 30 },
      { situation: 'everything held, from the day of the oldest attempt', period: 'all' as const, oldest: Date.UTC(2026, 9, 14, 8, 0), first: '2026-10-14', count: 18 },
      { situation: 'everything held with nothing stored', period: 'all' as const, oldest: null, first: '2026-10-31', count: 1 },
    ])('$situation', ({ period, oldest, first, count }) => {
      const days = periodDays(period, now, oldest);

      expect([days[0], days.length, days.at(-1)]).toEqual([first, count, '2026-10-31']);
    });
  });

  describe("a workflow's prompt tells Claude what failed, where, how often and with which links, and to fix the cause rather than retry", () => {
    it('names the workflow, its figures on main and branches, each top cause with its error and newest runs, main first', () => {
      const attempts = [
        failing({ failedJobs: [{ ...job('Test', ['a dismissed item leaves the lists']), url: 'https://github.com/o/r/actions/runs/7/job/1' }] }),
        attempt({ attempt: 2, minutes: 5 }),
        failing({ ...onBranch, sha: 'b', minutes: 9, failedJobs: [{ ...job('Test', ['a dismissed item leaves the lists']), url: 'https://github.com/o/r/actions/runs/8/job/1' }] }),
        attempt({ ...onBranch, sha: 'b', attempt: 2, minutes: 12 }),
      ];

      const prompt = workflowPrompt(workflowFigures('CI', attempts, flakyAmong(attempts)), 7);

      expect(prompt.split('\n')).toEqual([
        'The "CI" GitHub Actions workflow in this repository is unstable. Over the last 7 days, on main (including scheduled and manual runs) it passed 50% of its runs, with 1 failure, 1 of which passed on a later attempt of the same commit. On feature branches it failed and then passed on the same commit 1 time.',
        'A failure on main matters most: it breaks main for everyone. Fix those first.',
        '',
        'What made it fail, main first:',
        '- Test "a dismissed item leaves the lists" (apps/api/tests/integration/triage.test.ts · Test): 1 failure on main (1 flaky), 1 flaky on feature branches',
        '  Error: AssertionError: expected 1 to be 2',
        '  https://github.com/o/r/actions/runs/7/job/1 (main, passed on a later attempt)',
        '  https://github.com/o/r/actions/runs/8/job/1 (feature branch, passed on a later attempt)',
        '',
        "Read the failed runs' logs to find the root cause of each, then fix it. A cause that failed and then passed on the same commit is not the change being wrong: find what makes it nondeterministic. A cause that stayed failed on main is a break: find what broke it. Never retry to green; fix, quarantine with an owner, or delete, per docs/testing-strategy.md. Say which causes you fixed and which need a decision from me.",
      ]);
    });
  });
});
