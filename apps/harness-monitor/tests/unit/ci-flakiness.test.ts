import { describe, expect, it } from 'vitest';
import { causesOf, flakyAmong, fragileTests, periodDays, sortFigures, testPrompt, whereOf, workflowFigures, workflowPrompt, type Attempt, type FailedJob } from '../../src/ci-flakiness';

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

  describe('a test is listed once it failed on a commit a later attempt passed, and counted on main and on branches apart', () => {
    /** A failed job naming one test of `file`, in the Playwright project `project`, with `error`. */
    const testJob = (name: string, over: { file?: string; project?: string | null; error?: string | null; job?: string } = {}): FailedJob => ({
      name: over.job ?? 'Test',
      step: 'Run pnpm test',
      url: `https://github.com/o/r/actions/runs/1/job/${(over.job ?? 'Test').length}`,
      tests: [{ file: over.file ?? 'apps/api/tests/integration/triage.test.ts', name, project: over.project ?? null, error: over.error === undefined ? 'AssertionError: expected 1 to be 2' : over.error }],
    });
    const listed = (attempts: Attempt[], sort = 'main') => fragileTests(attempts, flakyAmong(attempts), sort);
    const counts = (attempts: Attempt[]) => listed(attempts).map((t) => [t.cause.label, t.cause.main, t.cause.branch]);
    const x = () => ({ failedJobs: [testJob('Triage > x')] });

    it.each([
      { situation: 'a test that only ever failed on a commit a later commit replaced', attempts: () => [failing({ ...onBranch, ...x() }), attempt({ ...onBranch, sha: 'b', minutes: 5 })], expected: [] },
      { situation: 'a test that failed on a branch and was never re-run', attempts: () => [failing({ ...onBranch, ...x() })], expected: [] },
      { situation: 'a test that failed on main and was never re-run', attempts: () => [failing(x())], expected: [] },
      { situation: 'a test flaky once on a branch', attempts: () => [failing({ ...onBranch, ...x() }), attempt({ ...onBranch, attempt: 2, minutes: 5 })], expected: [['Triage > x', 0, 1]] },
      { situation: 'a test flaky once on main', attempts: () => [failing(x()), attempt({ attempt: 2, minutes: 5 })], expected: [['Triage > x', 1, 0]] },
      {
        situation: 'a test flaky on a branch and failing on main twice',
        attempts: () => [failing({ ...onBranch, ...x() }), attempt({ ...onBranch, attempt: 2, minutes: 1 }), failing({ sha: 'b', minutes: 2, ...x() }), failing({ sha: 'c', minutes: 3, ...x() })],
        expected: [['Triage > x', 2, 1]],
      },
      {
        situation: "a branch's failure that stayed failed beside one that did not",
        attempts: () => [failing({ ...onBranch, ...x() }), attempt({ ...onBranch, attempt: 2, minutes: 1 }), failing({ ...onBranch, sha: 'b', minutes: 2, ...x() })],
        expected: [['Triage > x', 0, 1]],
      },
    ])('$situation', ({ attempts, expected }) => {
      expect(counts(attempts())).toEqual(expected);
    });

    it('a step that failed and passed on a re-run is no test and is not listed', () => {
      const attempts = [failing({ failedJobs: [job('Lint', [], 'Run pnpm lint')] }), attempt({ attempt: 2, minutes: 5 })];

      expect(listed(attempts)).toEqual([]);
    });

    it('the same test failing on phone and desktop in one attempt is one test, counted once, both projects named', () => {
      const e2e = (project: string) => testJob('Capture > a thought is kept', { file: 'tests/e2e/capture.test.ts', project, job: 'E2E (F3)' });
      const attempts = [failing({ failedJobs: [e2e('desktop'), e2e('phone')] }), attempt({ attempt: 2, minutes: 5 })];

      const [test, ...others] = listed(attempts);

      expect(others).toEqual([]);
      expect(test!.cause).toMatchObject({ main: 1, mainFlaky: 1, file: 'tests/e2e/capture.test.ts', projects: ['desktop', 'phone'], jobs: ['CI · E2E (F3)'] });
    });

    it("its error is the newest flaky failure's, not a later failure that stayed failed", () => {
      const attempts = [
        failing({ failedJobs: [testJob('Triage > x', { error: 'Timeout 5000ms' })] }),
        attempt({ attempt: 2, minutes: 1 }),
        failing({ sha: 'b', minutes: 9, failedJobs: [testJob('Triage > x', { error: 'a real break' })] }),
      ];

      expect(listed(attempts)[0]).toMatchObject({ error: 'Timeout 5000ms', last: { at: at(0), main: true } });
    });

    it('its last flaky failure is the newest one, on main or on a branch', () => {
      const attempts = [
        failing({ ...onBranch, minutes: 9, ...x() }),
        attempt({ ...onBranch, attempt: 2, minutes: 10 }),
        failing({ sha: 'b', minutes: 1, ...x() }),
        attempt({ sha: 'b', attempt: 2, minutes: 2 }),
      ];

      expect(listed(attempts)[0]!.last).toMatchObject({ at: at(9), main: false });
    });

    describe('Most on main and Most in total order the list', () => {
      const flakyOnMain = (name: string, minutes: number, sha: string) => [failing({ sha, minutes, failedJobs: [testJob(name)] }), attempt({ sha, attempt: 2, minutes: minutes + 1 })];
      const flakyOnBranch = (name: string, minutes: number, sha: string) => [failing({ ...onBranch, sha, minutes, failedJobs: [testJob(name)] }), attempt({ ...onBranch, sha, attempt: 2, minutes: minutes + 1 })];
      const scenario = [
        // one on main and four on branches: five in total
        ...flakyOnMain('on branches', 0, 'a'),
        ...[1, 2, 3, 4].flatMap((i) => flakyOnBranch('on branches', 10 * i, `b${i}`)),
        // three on main
        ...[1, 2, 3].flatMap((i) => flakyOnMain('on main', 100 + 10 * i, `c${i}`)),
        // one on each side, the newer of the two listed first
        ...flakyOnMain('tied, older', 200, 'd'),
        ...flakyOnBranch('tied, older', 205, 'e'),
        ...flakyOnMain('tied, newer', 300, 'f'),
        ...flakyOnBranch('tied, newer', 305, 'g'),
      ];

      it.each([
        { situation: 'Most on main puts main first, then the branches, then the newest', sort: 'main', expected: ['on main', 'on branches', 'tied, newer', 'tied, older'] },
        { situation: 'Most in total puts the sum first, then the newest', sort: 'all', expected: ['on branches', 'on main', 'tied, newer', 'tied, older'] },
      ])('$situation', ({ sort, expected }) => {
        expect(listed(scenario, sort).map((t) => t.cause.label)).toEqual(expected);
      });
    });
  });

  describe("a fragile test's prompt names the test, its file, its counts, its error and its runs, main first, and to fix the cause rather than retry", () => {
    it('names the test with its file and projects, how often it failed on main and on branches, its latest error and its newest runs', () => {
      const failed = (over: Partial<Attempt> & { minutes?: number }, url: string, project: string) =>
        failing({ ...over, failedJobs: [{ name: 'E2E (F3)', step: 'Run pnpm test:e2e', url, tests: [{ file: 'tests/e2e/capture.test.ts', name: 'Capture > a thought is kept', project, error: 'Timeout 5000ms' }] }] });
      const attempts = [
        failed({}, 'https://github.com/o/r/actions/runs/7/job/1', 'phone'),
        attempt({ attempt: 2, minutes: 5 }),
        failed({ sha: 'b', minutes: 9 }, 'https://github.com/o/r/actions/runs/9/job/1', 'desktop'),
        failed({ ...onBranch, sha: 'c', minutes: 12 }, 'https://github.com/o/r/actions/runs/8/job/1', 'phone'),
        attempt({ ...onBranch, sha: 'c', attempt: 2, minutes: 14 }),
      ];

      const prompt = testPrompt(fragileTests(attempts, flakyAmong(attempts), 'main')[0]!);

      expect(prompt.split('\n')).toEqual([
        'The test "Capture > a thought is kept" in tests/e2e/capture.test.ts (Playwright projects: phone, desktop) is fragile in CI. It failed and then passed on the same commit 1 time on main and 1 time on feature branches, and failed on main without passing afterwards 1 time. It runs in CI · E2E (F3).',
        '',
        'Its latest error: Timeout 5000ms',
        '',
        'Failed runs, main first, newest first:',
        '- https://github.com/o/r/actions/runs/9/job/1 (main, stayed failed)',
        '- https://github.com/o/r/actions/runs/7/job/1 (main, passed on a later attempt)',
        '- https://github.com/o/r/actions/runs/8/job/1 (feature branch, passed on a later attempt)',
        '',
        "Read those runs' logs and the test, find what makes it nondeterministic (timing, ordering, shared state, load), and fix the cause in the test or the code under test. Do not add retries or raise timeouts to hide it. Reproduce under load where you can (pin the suite to two cores). Follow the testing skill.",
      ]);
    });
  });
});
