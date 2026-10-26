import { startOfDay } from './belgium';
import { firstDay as periodFirstDay, PERIODS, type Period } from './costs';
import { redNowFrom, redNowStatements } from './ci-flakiness-report';
import type { RedNow } from './ci-flakiness';
import type { Outcome } from './stability';
import { stabilityWindows, type Durations, type WindowSpan } from './stability-store';

/**
 * What the CI stability page reads of the stored runs, and the arithmetic over
 * it: how a job's pass rate is counted, how long `main` was red once
 * overlapping spells are merged, and the order each tab is read in. The
 * queries only gather; every figure the page draws is worked out here, from the
 * runs, jobs and steps the Stability job stored (src/stability-store.ts).
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

function groupBy<T, K>(list: T[], key: (item: T) => K): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const item of list) {
    const own = groups.get(key(item));
    if (own) own.push(item);
    else groups.set(key(item), [item]);
  }
  return groups;
}

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

export interface FinishedRun {
  id: number;
  workflow: string;
  outcome: 'pass' | 'fail';
  createdAt: number;
  url: string;
  headSha: string;
}

export interface Spell {
  workflow: string;
  from: number;
  fromUrl: string;
  /** The first passing run after it; null while none has. */
  until: number | null;
  untilUrl: string | null;
  ongoing: boolean;
  /** Distinct commits that failed during it. */
  commits: number;
  /** The failing run that opened it. */
  openedBy: number;
}

/**
 * A workflow's red spells: from a failing run to the next passing one. Only a
 * pass closes one and only a fail opens one, and consecutive failures are one
 * spell, so a stretch is counted once. Newest first.
 */
export function redSpells(runs: FinishedRun[]): Spell[] {
  const spells: Spell[] = [];
  const byWorkflow = groupBy(runs, (r) => r.workflow);
  for (const [workflow, own] of byWorkflow) {
    let open: { from: FinishedRun; shas: Set<string> } | null = null;
    for (const run of [...own].sort((a, b) => a.createdAt - b.createdAt)) {
      if (run.outcome === 'fail') {
        open ??= { from: run, shas: new Set() };
        open.shas.add(run.headSha);
      } else if (open) {
        spells.push({ workflow, from: open.from.createdAt, fromUrl: open.from.url, until: run.createdAt, untilUrl: run.url, ongoing: false, commits: open.shas.size, openedBy: open.from.id });
        open = null;
      }
    }
    if (open) spells.push({ workflow, from: open.from.createdAt, fromUrl: open.from.url, until: null, untilUrl: null, ongoing: true, commits: open.shas.size, openedBy: open.from.id });
  }
  return spells.sort((a, b) => b.from - a.from);
}

/** A spell as a span; one still open runs to `now`. */
export const spellSpan = (s: Spell, now: number): [number, number] => [s.from, s.until ?? now];

/** Total length of a set of spans once overlaps are merged: two workflows red at once is one hour of red, not two. */
export function unionMs(spans: [number, number][]): number {
  const sorted = spans.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  let total = 0;
  let start = -Infinity;
  let end = -Infinity;
  for (const [a, b] of sorted) {
    if (a > end) {
      if (end > start) total += end - start;
      start = a;
      end = b;
    } else end = Math.max(end, b);
  }
  if (end > start) total += end - start;
  return total;
}

/** The part of each span inside `from` to `to`. */
export const clipSpans = (spans: [number, number][], from: number, to: number): [number, number][] =>
  spans.map(([a, b]): [number, number] => [Math.max(a, from), Math.min(b, to)]).filter(([a, b]) => b > a);

/** Time `main` was red in `from` to `to`, overlapping spells across workflows counted once. */
export const redMs = (spells: Spell[], from: number, to: number) => unionMs(clipSpans(spells.map((s) => spellSpan(s, to)), from, to));

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

/** Least reliable first (no verdict last, then the busier), slowest first, or most failures first. */
export function sortJobs<T extends { job: Ranked }>(rows: T[], sort: string): T[] {
  return [...rows].sort((a, b) =>
    sort === 'slowest'
      ? nullLast(a.job.durations?.median, b.job.durations?.median, true)
      : sort === 'failures'
        ? b.job.tally.fail - a.job.tally.fail || nullLast(a.job.tally.rate, b.job.tally.rate)
        : nullLast(a.job.tally.rate, b.job.tally.rate) || b.job.tally.completed - a.job.tally.completed,
  );
}

// ---- Reading the stored runs

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

export interface StabilityData {
  /** The first instant of the period, or the oldest stored run when that is later. */
  from: number;
  until: number;
  /** Whole Belgian days from `from` to `until`, at least one. */
  heldDays: number;
  /** The days the period names, or null for all time. */
  periodDays: number | null;
  /** The stored runs begin after the period does: part of the period is not stored. */
  partial: boolean;
  runs: number;
  /** In the period, by workflow. */
  workflows: WorkflowModel[];
  /** Every workflow that ever finished a run, by name: the Workflow filter's choices, and the order a series takes its colour in. */
  finishedWorkflows: string[];
  /** Every workflow's last finished run, and every job's, over all stored runs. */
  lastRuns: { workflow: string; last: Last | null; jobs: { name: string; last: Last }[] }[];
  /** Every spell stored, newest first; the page keeps those that reach into the period. */
  spells: Spell[];
  /** The workflows whose newest attempt on main failed, read from the stored attempts. */
  redNow: RedNow[];
  /** Runs and jobs whose conclusion the report does not recognise, in the period: said, not counted. */
  unrecognised: { conclusion: string; count: number }[];
}

type Row = Record<string, string | number | null>;

const JOB_TALLIES = `SELECT r.workflow, j.name AS job, j.outcome, COUNT(*) AS n
FROM stability_jobs j JOIN stability_runs r ON r.run_id = j.run_id
WHERE r.created_at >= ?1 GROUP BY r.workflow, j.name, j.outcome`;

const RUN_TALLIES = 'SELECT workflow, outcome, COUNT(*) AS n FROM stability_runs WHERE created_at >= ?1 GROUP BY workflow, outcome';

/** Each workflow's newest run that passed or failed, over every stored run: "did it pass the last time it ran" is not a question about a period. */
const LAST_RUNS = `SELECT workflow, outcome, at, url FROM (
  SELECT workflow, outcome, created_at AS at, url, ROW_NUMBER() OVER (PARTITION BY workflow ORDER BY created_at DESC) AS rn
  FROM stability_runs WHERE outcome IN ('pass', 'fail')
) WHERE rn = 1`;

/** The same for each job, from the run it ran in: a job can have last run in an older run than its workflow. */
const LAST_JOBS = `SELECT workflow, job, outcome, at, url FROM (
  SELECT r.workflow, j.name AS job, j.outcome, r.created_at AS at, COALESCE(j.url, r.url) AS url,
         ROW_NUMBER() OVER (PARTITION BY r.workflow, j.name ORDER BY r.created_at DESC, j.job_index) AS rn
  FROM stability_jobs j JOIN stability_runs r ON r.run_id = j.run_id WHERE j.outcome IN ('pass', 'fail')
) WHERE rn = 1`;

const FINISHED_RUNS = `SELECT run_id AS id, workflow, outcome, created_at AS createdAt, url, head_sha AS headSha
FROM stability_runs WHERE outcome IN ('pass', 'fail') ORDER BY created_at`;

const UNRECOGNISED = `SELECT conclusion, COUNT(*) AS n FROM (
  SELECT conclusion FROM stability_runs WHERE outcome = 'unknown' AND created_at >= ?1
  UNION ALL
  SELECT j.conclusion FROM stability_jobs j JOIN stability_runs r ON r.run_id = j.run_id WHERE j.outcome = 'unknown' AND r.created_at >= ?1
) GROUP BY conclusion ORDER BY conclusion`;

const asLast = (row: Row): Last => ({ outcome: row.outcome as 'pass' | 'fail', at: row.at as number, url: row.url as string });

/** Everything the page draws, read in one round trip over the stored runs. */
export async function loadStability(db: D1Database, period: Period, now: number): Promise<StabilityData> {
  const first = periodFirstDay(period, now);
  const start = first === null ? 0 : startOfDay(first);
  const span: WindowSpan = { days: PERIODS[period], firstDay: first };

  const [windows, [jobTallies, runTallies, lastRuns, lastJobs, finished, unrecognised, oldest, ...red]] = await Promise.all([
    stabilityWindows(db, [span]),
    db.batch<Row>([
      db.prepare(JOB_TALLIES).bind(start),
      db.prepare(RUN_TALLIES).bind(start),
      db.prepare(LAST_RUNS),
      db.prepare(LAST_JOBS),
      db.prepare(FINISHED_RUNS),
      db.prepare(UNRECOGNISED).bind(start),
      db.prepare('SELECT MIN(created_at) AS oldest FROM stability_runs'),
      ...redNowStatements(db),
    ]),
  ]);
  const window = windows[0]!;
  const held = oldest!.results[0]!.oldest as number | null;

  const durationsOf = new Map<string, (typeof window.workflows)[number]['jobs'][number]>(window.workflows.flatMap((w) => w.jobs.map((j): [string, typeof j] => [`${w.name}|${j.name}`, j])));
  const jobCounts = new Map<string, Partial<Record<Outcome, number>>>();
  for (const row of jobTallies!.results) {
    const key = `${row.workflow}|${row.job}`;
    jobCounts.set(key, { ...jobCounts.get(key), [row.outcome as Outcome]: row.n as number });
  }
  const runCounts = new Map<string, Partial<Record<Outcome, number>>>();
  for (const row of runTallies!.results) runCounts.set(row.workflow as string, { ...runCounts.get(row.workflow as string), [row.outcome as Outcome]: row.n as number });

  const workflows = [...runCounts.keys()].sort().map((name): WorkflowModel => ({
    name,
    tally: tallyOf(runCounts.get(name)!),
    jobs: [...jobCounts.keys()]
      .filter((key) => key.startsWith(`${name}|`))
      .map((key) => {
        const job = key.slice(name.length + 1);
        const timed = durationsOf.get(key);
        return { name: job, tally: tallyOf(jobCounts.get(key)!), durations: timed?.durations ?? null, steps: timed?.steps ?? [] };
      })
      .sort((a, b) => a.name.localeCompare(b.name)),
  }));

  const runs = finished!.results.map((r): FinishedRun => r as unknown as FinishedRun);
  const lastJobsOf = groupBy(lastJobs!.results, (r) => r.workflow as string);
  const lastRunOf = new Map(lastRuns!.results.map((r) => [r.workflow as string, asLast(r)]));
  const names = new Set([...lastRunOf.keys(), ...lastJobsOf.keys()]);

  const periodStart = start === 0 ? (held ?? now) : Math.max(start, held ?? start);
  return {
    from: periodStart,
    until: now,
    heldDays: Math.max(1, Math.round((now - periodStart) / 86_400_000)),
    periodDays: PERIODS[period],
    partial: held !== null && start > 0 && held > start,
    runs: window.runs,
    workflows,
    finishedWorkflows: [...new Set(runs.map((r) => r.workflow))].sort(),
    lastRuns: [...names].sort().map((workflow) => ({
      workflow,
      last: lastRunOf.get(workflow) ?? null,
      jobs: (lastJobsOf.get(workflow) ?? []).map((r) => ({ name: r.job as string, last: asLast(r) })),
    })),
    spells: redSpells(runs),
    redNow: redNowFrom(red as { results: Row[] }[]),
    unrecognised: unrecognised!.results.map((r) => ({ conclusion: String(r.conclusion), count: r.n as number })),
  };
}
