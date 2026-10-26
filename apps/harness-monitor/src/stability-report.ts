import { jobKey } from './ci-flakiness';
import { load, startOf, type WorkflowData } from './ci-flakiness-report';
import { PERIODS, type Period } from './costs';
import type { Outcome } from './stability';
import { durationsByWorkflow, jobDurationsSql, MAIN_ATTEMPTS, stepDurationsSql, type Durations } from './stability-store';

/**
 * What the CI stability page's Job tab reads of the stored attempts
 * (src/ci-attempts-store.ts), and the arithmetic over it: how a job's pass rate
 * is counted on main and the order each tab is read in. The queries only
 * gather; every figure the page draws is worked out here, or, for the failures
 * counted against a job, in src/ci-flakiness.ts.
 */

export const GROUPS = ['job', 'workflow', 'tests'] as const;
export type Group = (typeof GROUPS)[number];

/** The orders each tab can be read in; the first is its default. */
export const SORTS: Record<Group, [key: string, label: string][]> = {
  job: [['worst', 'Least reliable'], ['slowest', 'Slowest'], ['failures', 'Most failures']],
  workflow: [['worst', 'Least reliable'], ['failures', 'Most failures']],
  tests: [['main', 'Most on main'], ['all', 'Most in total']],
};

/** Tabs that were merged into Workflow: an address that names one still opens it. */
const MERGED_INTO_WORKFLOW = ['red', 'failures', 'day'];

export const DEFAULT_PERIOD: Period = '7d';

export interface StabilityQuery {
  period: Period;
  workflow: string | null;
  group: Group;
  /** Null for the tab's default order. */
  sort: string | null;
  /** `workflow|job`: the job whose steps are open. Only on the Job tab. */
  steps: string | null;
}

/** The view the address asks for; anything unrecognised falls back to the default. */
export function parseStabilityQuery(params: URLSearchParams): StabilityQuery {
  const period = params.get('period');
  const asked = params.get('group');
  const group = GROUPS.find((g) => g === asked) ?? (MERGED_INTO_WORKFLOW.includes(asked ?? '') ? 'workflow' : 'job');
  const sort = params.get('sort');
  return {
    period: period !== null && Object.hasOwn(PERIODS, period) ? (period as Period) : DEFAULT_PERIOD,
    workflow: params.get('workflow') || null,
    group,
    sort: sort !== null && SORTS[group].some(([k]) => k === sort) && sort !== SORTS[group][0]![0] ? sort : null,
    steps: group === 'job' ? params.get('steps') || null : null,
  };
}

/** The address of a view: a query with some of it changed. Defaults are left out, so one view has one address (and one cache entry). */
export function stabilityAddress(q: StabilityQuery, over: Partial<StabilityQuery> = {}): string {
  const all = { ...q, ...over };
  const params = new URLSearchParams();
  if (all.period !== DEFAULT_PERIOD) params.set('period', all.period);
  if (all.workflow !== null) params.set('workflow', all.workflow);
  if (all.group !== 'job') params.set('group', all.group);
  if (all.sort !== null) params.set('sort', all.sort);
  if (all.steps !== null && all.group === 'job') params.set('steps', all.steps);
  const text = params.toString();
  return text === '' ? '/stability' : `/stability?${text}`;
}

/** The order a tab is read in: the one the address names, else the tab's first. */
export const sortOf = (q: StabilityQuery) => q.sort ?? SORTS[q.group][0]?.[0] ?? '';

// ---- Counting

export interface Tally {
  pass: number;
  fail: number;
  cancelled: number;
  skipped: number;
  running: number;
  other: number;
  unknown: number;
  /** Passed plus failed: the runs that finished with a verdict. */
  completed: number;
  /** Null, not 0, when nothing finished: a job nobody has finished has no reliability. */
  rate: number | null;
}

/** A pass rate counts only what finished: a cancelled or skipped run is apart from it, not a failure. */
export function tallyOf(counts: Partial<Record<Outcome, number>>): Tally {
  const t = { pass: 0, fail: 0, cancelled: 0, skipped: 0, running: 0, other: 0, unknown: 0, ...counts };
  const completed = t.pass + t.fail;
  return { ...t, completed, rate: completed === 0 ? null : t.pass / completed };
}

export function sumTallies(list: Tally[]): Tally {
  const total: Partial<Record<Outcome, number>> = {};
  for (const t of list) for (const k of ['pass', 'fail', 'cancelled', 'skipped', 'running', 'other', 'unknown'] as const) total[k] = (total[k] ?? 0) + t[k];
  return tallyOf(total);
}

// ---- Ordering

/** Ascending, a missing value last; descending puts the largest first and a missing value last still. */
export function nullLast(a: number | null | undefined, b: number | null | undefined, desc = false): number {
  if (a == null) return b == null ? 0 : 1;
  if (b == null) return -1;
  return desc ? b - a : a - b;
}

interface Ranked {
  tally: Tally;
  durations: { median: number } | null;
}

/** Least reliable on main first (no verdict last, then the busier), slowest first, or most failures on main first; the flaky failures on feature branches break a tie. */
export function sortJobs<T extends { job: Ranked; branchFlaky: number }>(rows: T[], sort: string): T[] {
  return [...rows].sort((a, b) =>
    sort === 'slowest'
      ? nullLast(a.job.durations?.median, b.job.durations?.median, true)
      : sort === 'failures'
        ? b.job.tally.fail - a.job.tally.fail || b.branchFlaky - a.branchFlaky || nullLast(a.job.tally.rate, b.job.tally.rate)
        : nullLast(a.job.tally.rate, b.job.tally.rate) || b.job.tally.completed - a.job.tally.completed || b.branchFlaky - a.branchFlaky,
  );
}

// ---- Reading the stored attempts

export interface Step {
  name: string;
  occurrence: number;
  durations: Durations | null;
}

export interface JobModel {
  name: string;
  tally: Tally;
  durations: Durations | null;
  steps: Step[];
}

export interface WorkflowModel {
  name: string;
  tally: Tally;
  jobs: JobModel[];
}

export interface Last {
  outcome: 'pass' | 'fail';
  at: number;
  url: string;
}

/** What the Job tab draws: the attempts every tab reads, and main's runs of each job counted and timed. */
export interface StabilityData extends WorkflowData {
  /** In the period on main, by workflow. */
  main: WorkflowModel[];
  /** Every workflow's last finished attempt on main, and every job's, over all stored attempts. */
  lastRuns: { workflow: string; last: Last | null; jobs: { name: string; last: Last }[] }[];
  /** Attempts and jobs on main whose conclusion the report does not recognise, in the period: said, not counted. */
  unrecognised: { conclusion: string; count: number }[];
}

type Row = Record<string, string | number | null>;

const JOB_TALLIES = `SELECT a.workflow, j.name AS job, j.outcome, COUNT(*) AS n
FROM ci_attempt_jobs j JOIN ci_attempts a ON a.run_id = j.run_id AND a.attempt = j.attempt
WHERE a.on_main = 1 AND a.created_at >= ?1 GROUP BY a.workflow, j.name, j.outcome`;

const RUN_TALLIES = 'SELECT workflow, outcome, COUNT(*) AS n FROM ci_attempts WHERE on_main = 1 AND created_at >= ?1 GROUP BY workflow, outcome';

/** Each workflow's newest attempt on main that passed or failed, over every stored attempt: "did it pass the last time it ran" is not a question about a period. */
const LAST_RUNS = `SELECT workflow, outcome, at, url FROM (
  SELECT workflow, outcome, created_at AS at, url, ROW_NUMBER() OVER (PARTITION BY workflow ORDER BY created_at DESC, attempt DESC) AS rn
  FROM ci_attempts WHERE on_main = 1 AND outcome IN ('pass', 'fail')
) WHERE rn = 1`;

/** The same for each job, from the attempt it ran in: a job can have last run in an older attempt than its workflow. */
const LAST_JOBS = `SELECT workflow, job, outcome, at, url FROM (
  SELECT a.workflow, j.name AS job, j.outcome, a.created_at AS at, COALESCE(j.url, a.url) AS url,
         ROW_NUMBER() OVER (PARTITION BY a.workflow, j.name ORDER BY a.created_at DESC, a.attempt DESC, j.job_index) AS rn
  FROM ci_attempt_jobs j JOIN ci_attempts a ON a.run_id = j.run_id AND a.attempt = j.attempt WHERE a.on_main = 1 AND j.outcome IN ('pass', 'fail')
) WHERE rn = 1`;

const UNRECOGNISED = `SELECT conclusion, COUNT(*) AS n FROM (
  SELECT conclusion FROM ci_attempts WHERE on_main = 1 AND outcome = 'unknown' AND created_at >= ?1
  UNION ALL
  SELECT j.conclusion FROM ci_attempt_jobs j JOIN ci_attempts a ON a.run_id = j.run_id AND a.attempt = j.attempt WHERE a.on_main = 1 AND j.outcome = 'unknown' AND a.created_at >= ?1
) GROUP BY conclusion ORDER BY conclusion`;

const asLast = (row: Row): Last => ({ outcome: row.outcome as 'pass' | 'fail', at: row.at as number, url: row.url as string });

/** Everything the Job tab draws, read in one round trip over the stored attempts: the attempts of every branch the Workflow tab reads, and main's jobs and steps counted and timed. */
export async function loadStability(db: D1Database, period: Period, now: number): Promise<StabilityData> {
  const start = startOf(period, now);
  const { data, extra } = await load(db, period, now, [
    db.prepare(JOB_TALLIES).bind(start),
    db.prepare(RUN_TALLIES).bind(start),
    db.prepare(LAST_RUNS),
    db.prepare(LAST_JOBS),
    db.prepare(UNRECOGNISED).bind(start),
    db.prepare(jobDurationsSql(MAIN_ATTEMPTS)).bind(start),
    db.prepare(stepDurationsSql(MAIN_ATTEMPTS)).bind(start),
  ]);
  const [jobTallies, runTallies, lastRuns, lastJobs, unrecognised, jobTimes, stepTimes] = extra;

  const timed = durationsByWorkflow(jobTimes!.results as never, stepTimes!.results as never);
  const durationsOf = new Map(timed.flatMap((w) => w.jobs.map((j): [string, typeof j] => [jobKey(w.name, j.name), j])));
  const jobCounts = new Map<string, { workflow: string; job: string; counts: Partial<Record<Outcome, number>> }>();
  for (const row of jobTallies!.results) {
    const key = jobKey(row.workflow as string, row.job as string);
    const own = jobCounts.get(key) ?? { workflow: row.workflow as string, job: row.job as string, counts: {} };
    own.counts[row.outcome as Outcome] = row.n as number;
    jobCounts.set(key, own);
  }
  const runCounts = new Map<string, Partial<Record<Outcome, number>>>();
  for (const row of runTallies!.results) runCounts.set(row.workflow as string, { ...runCounts.get(row.workflow as string), [row.outcome as Outcome]: row.n as number });

  const main = [...runCounts.keys()].sort().map((name): WorkflowModel => ({
    name,
    tally: tallyOf(runCounts.get(name)!),
    jobs: [...jobCounts.entries()]
      .filter(([, own]) => own.workflow === name)
      .map(([key, own]) => {
        const timed = durationsOf.get(key);
        return { name: own.job, tally: tallyOf(own.counts), durations: timed?.durations ?? null, steps: timed?.steps ?? [] };
      })
      .sort((a, b) => a.name.localeCompare(b.name)),
  }));

  const lastRunOf = new Map(lastRuns!.results.map((r) => [r.workflow as string, asLast(r)]));
  const lastJobsOf = new Map<string, { name: string; last: Last }[]>();
  for (const r of lastJobs!.results) lastJobsOf.set(r.workflow as string, [...(lastJobsOf.get(r.workflow as string) ?? []), { name: r.job as string, last: asLast(r) }]);
  const names = new Set([...lastRunOf.keys(), ...lastJobsOf.keys()]);

  return {
    ...data,
    main,
    lastRuns: [...names].sort().map((workflow) => ({ workflow, last: lastRunOf.get(workflow) ?? null, jobs: lastJobsOf.get(workflow) ?? [] })),
    unrecognised: unrecognised!.results.map((r) => ({ conclusion: String(r.conclusion), count: r.n as number })),
  };
}
