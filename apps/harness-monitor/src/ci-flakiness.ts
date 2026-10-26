import { addDays, belgianDay } from './belgium';
import { firstDay as periodFirstDay, type Period } from './costs';
import { pct } from './report';

/**
 * What the CI stability page works out of the stored attempts
 * (src/ci-attempts-store.ts): which failures say a workflow is unstable, what
 * made each fail, and the figures a workflow's row, strip and prompt are drawn
 * from. The queries only gather (src/ci-flakiness-report.ts); every figure is
 * counted here.
 *
 * Main is every attempt on `main`, scheduled and manual ones included; a feature
 * branch is any other. A failure is flaky when a later attempt on the same
 * commit passed. On main every failure counts, since main is never re-run; on a
 * feature branch only a flaky one does, since its other failures are usually the
 * change being wrong.
 */

export interface FailedTest {
  file: string;
  name: string;
  project: string | null;
  error: string | null;
}

export interface FailedJob {
  name: string;
  step: string | null;
  url: string | null;
  tests: FailedTest[];
}

/** An attempt that passed or failed; the page counts no other. Failed ones carry the jobs that failed in them. */
export interface Attempt {
  runId: number;
  attempt: number;
  workflow: string;
  event: string;
  branch: string | null;
  pull: number | null;
  onMain: boolean;
  sha: string;
  outcome: 'pass' | 'fail';
  /** Epoch milliseconds the attempt started. */
  at: number;
  url: string;
  failedJobs: FailedJob[];
}

/** One failure of a cause, for its row's strip and its prompt. */
export interface Run {
  at: number;
  url: string;
  main: boolean;
  flaky: boolean;
  /** Where it ran, and where it ran in which workflow, as plain text. */
  where: string;
  label: string;
  /** The error the failure carried, where it named one. */
  error: string | null;
}

/** What made attempts fail: a failing test where the attempt names one, otherwise the job and step. */
export interface Cause {
  key: string;
  label: string;
  sub: string;
  kind: 'test' | 'step' | 'unknown';
  /** Attempts it failed on main, and how many of those a later attempt passed. */
  main: number;
  mainFlaky: number;
  /** Flaky attempts on feature branches: the only ones a branch counts. */
  branch: number;
  last: Attempt;
  lastUrl: string;
  error: string | null;
  runs: Run[];
  /** A test cause's file, the Playwright projects it failed in and the workflow and job it failed in, each once; empty for a step. */
  file: string | null;
  projects: string[];
  jobs: string[];
}

export interface WorkflowFigures {
  name: string;
  /** Every attempt on main that passed or failed. */
  main: Attempt[];
  pass: number;
  failed: Attempt[];
  mainFlaky: number;
  /** The attempts on feature branches that failed and a later attempt on the same commit passed. */
  branchFlaky: Attempt[];
  /** Passed against passed and failed on main; null when none finished. */
  rate: number | null;
  causes: Cause[];
  last: Attempt | undefined;
}

/** The part of a workflow that is main's or a branch's: a commit's attempts are compared only with the same side's. */
const sideOf = (a: Attempt) => (a.onMain ? 'main' : 'branch');

/** Failed attempts that a later attempt on the same commit passed: proof the failure was not the change. A cancelled attempt is neither. */
export function flakyAmong(attempts: Attempt[]): Set<Attempt> {
  const groups = new Map<string, Attempt[]>();
  for (const a of attempts) {
    const key = `${a.workflow}|${a.sha}|${sideOf(a)}`;
    groups.set(key, [...(groups.get(key) ?? []), a]);
  }
  const flaky = new Set<Attempt>();
  for (const list of groups.values()) {
    list.sort((x, y) => x.at - y.at);
    list.forEach((a, i) => {
      if (a.outcome === 'fail' && list.slice(i + 1).some((b) => b.outcome === 'pass')) flaky.add(a);
    });
  }
  return flaky;
}

/** Where an attempt ran, as plain text. */
export function whereOf(a: Attempt): string {
  if (!a.onMain) return a.pull ? `pull request ${a.pull}` : (a.branch ?? 'a branch');
  return a.event === 'push' ? 'main' : a.event.replace(/_/g, ' ');
}

/** The causes of a set of failed attempts, main's most first, then the branches'. An attempt counts once for a cause however many of its jobs or projects failed on it. */
export function causesOf(failed: Attempt[], flaky: Set<Attempt>): Cause[] {
  const by = new Map<string, Cause>();
  const counted = new Set<string>();
  const add = (key: string, label: string, sub: string, kind: Cause['kind'], a: Attempt, url: string | null, error: string | null, test?: FailedTest, job?: string) => {
    const where = url ?? a.url;
    const c = by.get(key) ?? { key, label, sub, kind, main: 0, mainFlaky: 0, branch: 0, last: a, lastUrl: where, error, runs: [], file: test?.file ?? null, projects: [], jobs: [] };
    by.set(key, c);
    // Every project and job a test failed in is named, though its attempt counts once.
    if (test?.project && !c.projects.includes(test.project)) c.projects.push(test.project);
    const ran = job === undefined ? null : `${a.workflow} · ${job}`;
    if (ran !== null && !c.jobs.includes(ran)) c.jobs.push(ran);
    const once = `${key}|${a.runId}|${a.attempt}`;
    if (counted.has(once)) return;
    counted.add(once);
    if (a.onMain) {
      c.main++;
      if (flaky.has(a)) c.mainFlaky++;
    } else c.branch++;
    const place = whereOf(a);
    c.runs.push({ at: a.at, url: where, main: a.onMain, flaky: flaky.has(a), where: place, label: `${place} · ${a.workflow}`, error });
    if (a.at >= c.last.at) Object.assign(c, { last: a, lastUrl: where, error: error ?? c.error });
  };
  for (const a of failed) {
    if (!a.failedJobs.length) add('?', 'No failed job recorded', 'the run failed before or outside any job', 'unknown', a, a.url, null);
    for (const j of a.failedJobs) {
      if (j.tests.length) for (const t of j.tests) add(`t|${t.file}|${t.name}`, t.name, `${t.file} · ${j.name}`, 'test', a, j.url, t.error, t, j.name);
      else add(`s|${j.name}|${j.step}`, `${j.name} · ${j.step ?? 'no failing step'}`, 'no test named', 'step', a, j.url, null);
    }
  }
  return [...by.values()].sort((x, y) => y.main - x.main || y.branch - x.branch || y.last.at - x.last.at);
}

/** A test that failed and then passed on the same commit, on main or a feature branch, with what the page draws of it. */
export interface FragileTest {
  /** The test's failures: all on main, and the flaky ones on feature branches. */
  cause: Cause;
  /** Its newest flaky failure, which the bar's column and the error are read from. */
  last: Run;
  error: string | null;
}

/**
 * The tests a set of attempts shows to be fragile: every test that failed in
 * an attempt a later attempt on the same commit passed, on main or a branch,
 * with its failures counted as a workflow's causes are (every one on main, the
 * flaky ones on branches), most on main first or most in total first.
 */
export function fragileTests(attempts: Attempt[], flaky: Set<Attempt>, sort: string): FragileTest[] {
  const counted = attempts.filter((a) => a.outcome === 'fail' && (a.onMain || flaky.has(a)));
  return causesOf(counted, flaky)
    .filter((c) => c.kind === 'test' && c.mainFlaky + c.branch > 0)
    .map((cause): FragileTest => {
      const last = cause.runs.filter((r) => r.flaky).reduce((newer, r) => (r.at >= newer.at ? r : newer));
      return { cause, last, error: last.error ?? cause.error };
    })
    .sort((x, y) =>
      sort === 'all'
        ? y.cause.main + y.cause.branch - (x.cause.main + x.cause.branch) || y.last.at - x.last.at
        : y.cause.main - x.cause.main || y.cause.branch - x.cause.branch || y.last.at - x.last.at,
    );
}

/** A workflow's figures over the attempts in the period (every workflow's, which `flaky` was worked out over). */
export function workflowFigures(name: string, inPeriod: Attempt[], flaky: Set<Attempt>): WorkflowFigures {
  const own = inPeriod.filter((a) => a.workflow === name);
  const main = own.filter((a) => a.onMain);
  const pass = main.filter((a) => a.outcome === 'pass').length;
  const failed = main.filter((a) => a.outcome === 'fail');
  const branchFlaky = own.filter((a) => !a.onMain && flaky.has(a));
  const last = [...main].sort((x, y) => y.at - x.at)[0];
  return {
    name,
    main,
    pass,
    failed,
    mainFlaky: failed.filter((a) => flaky.has(a)).length,
    branchFlaky,
    rate: pass + failed.length ? pass / (pass + failed.length) : null,
    causes: causesOf([...failed, ...branchFlaky], flaky),
    last,
  };
}

/** Least reliable on main first (a workflow with no finished run on main last), or most failures on main first. */
export function sortFigures(rows: WorkflowFigures[], sort: string): WorkflowFigures[] {
  return [...rows].sort((a, b) =>
    sort === 'failures'
      ? b.failed.length - a.failed.length || b.branchFlaky.length - a.branchFlaky.length
      : (a.rate ?? 2) - (b.rate ?? 2) || b.failed.length - a.failed.length || b.branchFlaky.length - a.branchFlaky.length,
  );
}

/** The days a period covers, oldest first. Everything held runs from the oldest stored attempt. */
export function periodDays(period: Period, now: number, oldest: number | null): string[] {
  const today = belgianDay(now);
  const first = periodFirstDay(period, now) ?? (oldest === null ? today : belgianDay(oldest));
  const days: string[] = [];
  for (let d = first; d <= today; d = addDays(d, 1)) days.push(d);
  return days;
}

// ---- The prompts

/** A row's prompt names its failures newest first, main's before the branches', one link each. */
export const newest = (runs: Run[], n: number): Run[] =>
  [...new Map([...runs].sort((x, y) => Number(y.main) - Number(x.main) || y.at - x.at).map((r) => [r.url, r])).values()].slice(0, n);

const runLine = (r: Run) => `${r.url} (${r.main ? 'main' : 'feature branch'}${r.flaky ? ', passed on a later attempt' : ', stayed failed'})`;
export const times = (n: number, what: string, plural = 's') => `${n} ${what}${n === 1 ? '' : plural}`;

/** What a workflow's Copy prompt copies: what failed, where, how often, with links, and to fix the cause rather than retry. */
export function workflowPrompt(f: WorkflowFigures, days: number): string {
  return [
    `The "${f.name}" GitHub Actions workflow in this repository is unstable. Over the last ${days} days, on main (including scheduled and manual runs) it passed ${f.rate === null ? 'no' : pct(f.rate)} of its runs, with ${times(f.failed.length, 'failure')}, ${f.mainFlaky} of which passed on a later attempt of the same commit. On feature branches it failed and then passed on the same commit ${times(f.branchFlaky.length, 'time')}.`,
    'A failure on main matters most: it breaks main for everyone. Fix those first.',
    '',
    'What made it fail, main first:',
    ...f.causes.slice(0, 5).flatMap((c) => [
      `- ${c.kind === 'test' ? `Test "${c.label}" (${c.sub})` : c.label}: ${times(c.main, 'failure')} on main${c.mainFlaky ? ` (${c.mainFlaky} flaky)` : ''}, ${c.branch} flaky on feature branches`,
      ...(c.error ? [`  Error: ${c.error}`] : []),
      ...newest(c.runs, 3).map((r) => `  ${runLine(r)}`),
    ]),
    '',
    "Read the failed runs' logs to find the root cause of each, then fix it. A cause that failed and then passed on the same commit is not the change being wrong: find what makes it nondeterministic. A cause that stayed failed on main is a break: find what broke it. Never retry to green; fix, quarantine with an owner, or delete, per docs/testing-strategy.md. Say which causes you fixed and which need a decision from me.",
  ].join('\n');
}

/** What a fragile test's Copy prompt copies: the test, its file, its counts, its latest error and its newest failures, main first, and to fix the cause rather than retry. */
export function testPrompt({ cause: c, error }: FragileTest): string {
  const broke = c.main - c.mainFlaky;
  return [
    `The test "${c.label}" in ${c.file}${c.projects.length ? ` (Playwright project${c.projects.length === 1 ? '' : 's'}: ${c.projects.join(', ')})` : ''} is fragile in CI. It failed and then passed on the same commit ${times(c.mainFlaky, 'time')} on main and ${times(c.branch, 'time')} on feature branches${broke ? `, and failed on main without passing afterwards ${times(broke, 'time')}` : ''}. It runs in ${c.jobs.join(', ')}.`,
    ...(error ? ['', `Its latest error: ${error}`] : []),
    '',
    'Failed runs, main first, newest first:',
    ...newest(c.runs, 5).map((r) => `- ${runLine(r)}`),
    '',
    "Read those runs' logs and the test, find what makes it nondeterministic (timing, ordering, shared state, load), and fix the cause in the test or the code under test. Do not add retries or raise timeouts to hide it. Reproduce under load where you can (pin the suite to two cores). Follow the testing skill.",
  ].join('\n');
}

// ---- Red now

/** A workflow whose newest attempt on main failed. */
export interface RedNow {
  workflow: string;
  /** When its current run of failures on main began, and that attempt's address. */
  since: number;
  sinceUrl: string;
  jobs: { name: string; step: string | null; url: string | null }[];
}
