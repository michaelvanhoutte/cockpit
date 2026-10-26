import { startOfDay } from './belgium';
import { firstDay as periodFirstDay, PERIODS, type Period } from './costs';
import type { StabilityRun } from './stability';

/** The windows each answer carries, the shortest first: every one no longer than the period, and all of it for all time. */
const WINDOWS = ['7d', '30d', '90d'] as const;

/** The period the address asks for, as the costs page reads it; anything unrecognised is 30 days. */
export function parsePeriod(raw: string | null): Period {
  return raw !== null && Object.hasOwn(PERIODS, raw) ? (raw as Period) : '30d';
}

const UPSERT_RUNS = `INSERT INTO stability_runs (run_id, workflow, path, status, conclusion, outcome, head_sha, created_at, url, received_at)
SELECT value ->> '$.id', value ->> '$.workflow', value ->> '$.path', value ->> '$.status', value ->> '$.conclusion',
       value ->> '$.outcome', value ->> '$.headSha', value ->> '$.createdAt', value ->> '$.url', ?2
FROM json_each(?1) WHERE true
ON CONFLICT (run_id) DO UPDATE SET
  workflow = excluded.workflow, path = excluded.path, status = excluded.status, conclusion = excluded.conclusion,
  outcome = excluded.outcome, head_sha = excluded.head_sha, created_at = excluded.created_at, url = excluded.url,
  received_at = excluded.received_at`;

const INSERT_JOBS = `INSERT INTO stability_jobs (run_id, job_index, name, status, conclusion, outcome, started_at, completed_at, duration_ms, failed_step, url)
SELECT value ->> '$.runId', value ->> '$.jobIndex', value ->> '$.name', value ->> '$.status', value ->> '$.conclusion',
       value ->> '$.outcome', value ->> '$.startedAt', value ->> '$.completedAt', value ->> '$.durationMs',
       value ->> '$.failedStep', value ->> '$.url'
FROM json_each(?1)`;

const INSERT_STEPS = `INSERT INTO stability_steps (run_id, job_index, position, number, name, occurrence, conclusion, started_at, completed_at, duration_ms)
SELECT value ->> '$.runId', value ->> '$.jobIndex', value ->> '$.position', value ->> '$.number', value ->> '$.name',
       value ->> '$.occurrence', value ->> '$.conclusion', value ->> '$.startedAt', value ->> '$.completedAt', value ->> '$.durationMs'
FROM json_each(?1)`;

/**
 * Stores a send's runs, each replacing the run stored under its id with every
 * job and step beneath it, so a re-send or an overlapping one never doubles a
 * row and a re-run's later verdict wins. One D1 batch, one transaction: a send
 * lands whole or not at all, in five statements whatever its size.
 */
export async function storeRuns(db: D1Database, runs: StabilityRun[], now = Date.now()): Promise<{ stored: number }> {
  const ids = JSON.stringify(runs.map((r) => r.id));
  const jobs = runs.flatMap((r) => r.jobs.map(({ steps: _steps, ...job }) => ({ ...job, runId: r.id })));
  const steps = runs.flatMap((r) => r.jobs.flatMap((j) => j.steps.map((s) => ({ ...s, runId: r.id, jobIndex: j.jobIndex }))));
  await db.batch([
    db.prepare(UPSERT_RUNS).bind(JSON.stringify(runs.map(({ jobs: _jobs, ...run }) => run)), now),
    db.prepare('DELETE FROM stability_steps WHERE run_id IN (SELECT value FROM json_each(?1))').bind(ids),
    db.prepare('DELETE FROM stability_jobs WHERE run_id IN (SELECT value FROM json_each(?1))').bind(ids),
    db.prepare(INSERT_JOBS).bind(JSON.stringify(jobs)),
    db.prepare(INSERT_STEPS).bind(JSON.stringify(steps)),
  ]);
  return { stored: runs.length };
}

/** When the newest stored run was started, as ISO time, or null when none is stored: where the next send starts reading. */
export async function newestRun(db: D1Database): Promise<string | null> {
  const row = await db.prepare('SELECT MAX(created_at) AS newest FROM stability_runs').first<{ newest: number | null }>();
  return row?.newest == null ? null : new Date(row.newest).toISOString();
}

/** Median and p90 in milliseconds over the durations counted, as the tool's model reports them; null when none was. */
export interface Durations {
  median: number;
  p90: number;
  count: number;
}

export interface StabilityWindow {
  /** Its length in Belgian days, ending today; null for every stored run. */
  days: number | null;
  /** The first Belgian day inside it; null for every stored run. */
  firstDay: string | null;
  runs: number;
  workflows: {
    name: string;
    jobs: { name: string; durations: Durations | null; steps: { name: string; occurrence: number; durations: Durations | null }[] }[];
  }[];
}

export interface StabilityAnswer {
  period: Period;
  firstDay: string | null;
  windows: StabilityWindow[];
}

/**
 * Median (the middle pair averaged on an even count) and nearest-rank p90 of
 * `ms` per `keys`, in SQL so a view reads a few rows back rather than every
 * step stored. Nulls sort last, so the first `n` ranks are the counted ones.
 */
const quantilesSql = (keys: string) => `ranked AS (
  SELECT *,
    ROW_NUMBER() OVER (PARTITION BY ${keys} ORDER BY ms IS NULL, ms) AS rn,
    COUNT(ms) OVER (PARTITION BY ${keys}) AS n
  FROM counted
)`;
const MEDIAN = 'AVG(CASE WHEN n > 0 AND rn IN ((n + 1) / 2, (n + 2) / 2) THEN ms END)';
const P90 = 'MAX(CASE WHEN rn = (9 * n + 9) / 10 THEN ms END)';

/** Where durations are read from: the tables of a run's jobs and steps, joined to the run (`r`), and the run's own condition on `?1`, the window's first instant. */
export interface DurationTables {
  jobs: string;
  steps: string;
  where: string;
}

/** The runs the Stability job stored, which the JSON answer reads. */
export const STORED_RUNS: DurationTables = {
  jobs: 'stability_jobs j JOIN stability_runs r ON r.run_id = j.run_id',
  steps: 'stability_steps s JOIN stability_jobs j ON j.run_id = s.run_id AND j.job_index = s.job_index JOIN stability_runs r ON r.run_id = s.run_id',
  where: 'r.created_at >= ?1',
};

/** The stored attempts on `main`, which the Job tab reads: a branch attempt keeps no job or step. */
export const MAIN_ATTEMPTS: DurationTables = {
  jobs: 'ci_attempt_jobs j JOIN ci_attempts r ON r.run_id = j.run_id AND r.attempt = j.attempt',
  steps:
    'ci_attempt_steps s JOIN ci_attempt_jobs j ON j.run_id = s.run_id AND j.attempt = s.attempt AND j.job_index = s.job_index JOIN ci_attempts r ON r.run_id = s.run_id AND r.attempt = s.attempt',
  where: 'r.on_main = 1 AND r.created_at >= ?1',
};

/** Every job that ran in the window; only one that passed or failed counts towards its durations, as the tool counts them. */
export const jobDurationsSql = (t: DurationTables) => `WITH counted AS (
  SELECT r.workflow, j.name AS job, CASE WHEN j.outcome IN ('pass', 'fail') THEN j.duration_ms END AS ms
  FROM ${t.jobs}
  WHERE ${t.where}
), ${quantilesSql('workflow, job')}
SELECT workflow, job, ${MEDIAN} AS median, ${P90} AS p90, MAX(n) AS count
FROM ranked GROUP BY workflow, job ORDER BY workflow, job`;

/** Each step of a job that passed or failed, in the order of its median place in the job. */
export const stepDurationsSql = (t: DurationTables) => `WITH counted AS (
  SELECT r.workflow, j.name AS job, s.name AS step, s.occurrence, s.position, s.duration_ms AS ms
  FROM ${t.steps}
  WHERE ${t.where} AND j.outcome IN ('pass', 'fail')
), ${quantilesSql('workflow, job, step, occurrence')}, placed AS (
  SELECT *,
    ROW_NUMBER() OVER (PARTITION BY workflow, job, step, occurrence ORDER BY position) AS pn,
    COUNT(*) OVER (PARTITION BY workflow, job, step, occurrence) AS pc
  FROM ranked
)
SELECT workflow, job, step, occurrence, ${MEDIAN} AS median, ${P90} AS p90, MAX(n) AS count,
       AVG(CASE WHEN pn IN ((pc + 1) / 2, (pc + 2) / 2) THEN position END) AS at
FROM placed GROUP BY workflow, job, step, occurrence
ORDER BY workflow, job, at, step, occurrence`;

export interface QuantileRow {
  median: number | null;
  p90: number | null;
  count: number;
}

const durations = (row: QuantileRow): Durations | null =>
  row.count > 0 && row.median !== null && row.p90 !== null ? { median: row.median, p90: row.p90, count: row.count } : null;

/** The jobs' and steps' durations the two queries return, grouped under their workflow and job. */
export function durationsByWorkflow(
  jobRows: (QuantileRow & { workflow: string; job: string })[],
  stepRows: (QuantileRow & { workflow: string; job: string; step: string; occurrence: number })[],
): StabilityWindow['workflows'] {
  const workflows = new Map<string, StabilityWindow['workflows'][number]>();
  for (const row of jobRows) {
    if (!workflows.has(row.workflow)) workflows.set(row.workflow, { name: row.workflow, jobs: [] });
    workflows.get(row.workflow)!.jobs.push({
      name: row.job,
      durations: durations(row),
      steps: stepRows.filter((s) => s.workflow === row.workflow && s.job === row.job).map((s) => ({ name: s.step, occurrence: s.occurrence, durations: durations(s) })),
    });
  }
  return [...workflows.values()];
}

/** A window to read: its length in Belgian days and its first Belgian day, both null for every stored run. */
export interface WindowSpan {
  days: number | null;
  firstDay: string | null;
}

/** Each window's runs and, per workflow, each job's and step's durations: the shape the tool's model.json has. A window starts at the beginning of its first Belgian day. */
export async function stabilityWindows(db: D1Database, windows: WindowSpan[]): Promise<StabilityWindow[]> {
  const statements = windows.flatMap(({ firstDay }) => {
    const from = firstDay === null ? 0 : startOfDay(firstDay);
    return [
      db.prepare('SELECT COUNT(*) AS runs FROM stability_runs WHERE created_at >= ?1').bind(from),
      db.prepare(jobDurationsSql(STORED_RUNS)).bind(from),
      db.prepare(stepDurationsSql(STORED_RUNS)).bind(from),
    ];
  });
  const results = await db.batch(statements);

  return windows.map(({ days, firstDay }, i) => {
    const runs = (results[i * 3]!.results[0] as { runs: number }).runs;
    const jobRows = results[i * 3 + 1]!.results as (QuantileRow & { workflow: string; job: string })[];
    const stepRows = results[i * 3 + 2]!.results as (QuantileRow & { workflow: string; job: string; step: string; occurrence: number })[];
    return { days, firstDay, runs, workflows: durationsByWorkflow(jobRows, stepRows) };
  });
}

/** The stored runs for a period: each window up to it, the shortest first (`stabilityWindows`). */
export async function stabilityAnswer(db: D1Database, period: Period, now: number): Promise<StabilityAnswer> {
  const length = PERIODS[period];
  const spans: Period[] = [...WINDOWS.filter((w) => length === null || PERIODS[w] <= length), ...(length === null ? (['all'] as const) : [])];
  const windows = await stabilityWindows(
    db,
    spans.map((span) => ({ days: PERIODS[span], firstDay: periodFirstDay(span, now) })),
  );
  return { period, firstDay: windows.at(-1)!.firstDay, windows };
}
