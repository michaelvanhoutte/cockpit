import { startOfDay } from './belgium';
import type { Attempt, FailedJob, RedNow } from './ci-flakiness';
import { firstDay as periodFirstDay, type Period } from './costs';

/**
 * What the CI stability page reads of the stored attempts
 * (src/ci-attempts-store.ts): the period's attempts on every branch, the jobs
 * that failed in them with their failed tests, and which workflows are red now.
 * The queries only gather; every figure is worked out in src/ci-flakiness.ts.
 */

type Row = Record<string, string | number | null>;

const ATTEMPTS = `SELECT run_id AS runId, attempt, workflow, event, branch, pull_number AS pull, on_main AS onMain, head_sha AS sha, outcome, created_at AS at, url
FROM ci_attempts WHERE created_at >= ?1 AND outcome IN ('pass', 'fail')`;

const FAILED_JOBS = `SELECT f.run_id AS runId, f.attempt, f.position, f.name, f.step, f.url
FROM ci_failed_jobs f JOIN ci_attempts a ON a.run_id = f.run_id AND a.attempt = f.attempt
WHERE a.created_at >= ?1 AND a.outcome = 'fail' ORDER BY f.run_id, f.attempt, f.position`;

const FAILED_TESTS = `SELECT t.run_id AS runId, t.attempt, t.position, t.file, t.name, t.project, t.error
FROM ci_failed_tests t JOIN ci_attempts a ON a.run_id = t.run_id AND a.attempt = t.attempt
WHERE a.created_at >= ?1 AND a.outcome = 'fail' ORDER BY t.run_id, t.attempt, t.position, t.test_index`;

/** Each workflow's newest attempt on main that passed or failed, over every stored attempt: "did it pass the last time it ran" is not a question about a period. */
const NEWEST_RED = `SELECT run_id, attempt, workflow FROM (
  SELECT run_id, attempt, workflow, outcome, ROW_NUMBER() OVER (PARTITION BY workflow ORDER BY created_at DESC, attempt DESC) AS rn
  FROM ci_attempts WHERE on_main = 1 AND outcome IN ('pass', 'fail')
) WHERE rn = 1 AND outcome = 'fail'`;

/** When each workflow's failures on main since its last pass began. */
const RED_SINCE = `SELECT a.workflow, MIN(a.created_at) AS since, a.url
FROM ci_attempts a
WHERE a.on_main = 1 AND a.outcome = 'fail'
  AND a.created_at > COALESCE((SELECT MAX(p.created_at) FROM ci_attempts p WHERE p.on_main = 1 AND p.outcome = 'pass' AND p.workflow = a.workflow), 0)
GROUP BY a.workflow`;

const RED_JOBS = `SELECT n.workflow, f.name, f.step, f.url
FROM (${NEWEST_RED}) n JOIN ci_failed_jobs f ON f.run_id = n.run_id AND f.attempt = n.attempt
ORDER BY n.workflow, f.position`;

/** The three statements that read which workflows are red now, for a page's one batch; `redNowFrom` reads their results. */
export const redNowStatements = (db: D1Database): [D1PreparedStatement, D1PreparedStatement, D1PreparedStatement] => [db.prepare(NEWEST_RED), db.prepare(RED_SINCE), db.prepare(RED_JOBS)];

export function redNowFrom([newest, since, jobs]: { results: Row[] }[]): RedNow[] {
  const red = new Map(newest!.results.map((r) => [r.workflow as string, true]));
  return since!.results
    .filter((r) => red.has(r.workflow as string))
    .map((r): RedNow => ({
      workflow: r.workflow as string,
      since: r.since as number,
      sinceUrl: r.url as string,
      jobs: jobs!.results.filter((j) => j.workflow === r.workflow).map((j) => ({ name: j.name as string, step: j.step as string | null, url: j.url as string | null })),
    }))
    .sort((a, b) => a.workflow.localeCompare(b.workflow));
}

export interface WorkflowData {
  /** The period's attempts that passed or failed, on every branch; a failed one carries its failed jobs. */
  attempts: Attempt[];
  /** Every workflow with a stored attempt: the Workflow filter's choices. */
  workflows: string[];
  /** When the oldest stored attempt started; null when none is stored. */
  oldest: number | null;
  redNow: RedNow[];
}

/** The files Test selection counted a miss on a pull request merged in the period: a test that failed on main where its pull request did not run it. */
const MISSED_FILES = `SELECT DISTINCT m.path
FROM selection_misses m JOIN selection_pulls p ON p.pull_number = m.pull_number AND p.job = 'test'
WHERE p.merged_at >= ?1`;

const startOf = (period: Period, now: number) => {
  const first = periodFirstDay(period, now);
  return first === null ? 0 : startOfDay(first);
};

/** Everything the Workflow tab draws, read in one round trip over the stored attempts. */
export async function loadWorkflowData(db: D1Database, period: Period, now: number): Promise<WorkflowData> {
  return (await load(db, period, now, [])).data;
}

export interface FragileData extends WorkflowData {
  /** The files Test selection counts a miss, over the period. */
  missed: string[];
}

/** Everything the Fragile tests tab draws: the Workflow tab's attempts and the stored misses, in the same one round trip. */
export async function loadFragileData(db: D1Database, period: Period, now: number): Promise<FragileData> {
  const { data, extra } = await load(db, period, now, [db.prepare(MISSED_FILES).bind(startOf(period, now))]);
  return { ...data, missed: extra[0]!.results.map((r) => r.path as string) };
}

async function load(db: D1Database, period: Period, now: number, more: D1PreparedStatement[]): Promise<{ data: WorkflowData; extra: { results: Row[] }[] }> {
  const start = startOf(period, now);
  const [attempts, jobs, tests, workflows, oldest, ...rest] = await db.batch<Row>([
    db.prepare(ATTEMPTS).bind(start),
    db.prepare(FAILED_JOBS).bind(start),
    db.prepare(FAILED_TESTS).bind(start),
    db.prepare('SELECT DISTINCT workflow FROM ci_attempts ORDER BY workflow'),
    db.prepare('SELECT MIN(created_at) AS oldest FROM ci_attempts'),
    ...redNowStatements(db),
    ...more,
  ]);
  const red = rest.slice(0, 3);
  const extra = rest.slice(3);

  const testsOf = new Map<string, FailedJob['tests']>();
  for (const t of tests!.results) {
    const key = `${t.runId}|${t.attempt}|${t.position}`;
    testsOf.set(key, [...(testsOf.get(key) ?? []), { file: t.file as string, name: t.name as string, project: t.project as string | null, error: t.error as string | null }]);
  }
  const jobsOf = new Map<string, FailedJob[]>();
  for (const j of jobs!.results) {
    const key = `${j.runId}|${j.attempt}`;
    jobsOf.set(key, [...(jobsOf.get(key) ?? []), { name: j.name as string, step: j.step as string | null, url: j.url as string | null, tests: testsOf.get(`${key}|${j.position}`) ?? [] }]);
  }
  const data: WorkflowData = {
    attempts: attempts!.results.map(
      (r): Attempt => ({
        runId: r.runId as number,
        attempt: r.attempt as number,
        workflow: r.workflow as string,
        event: r.event as string,
        branch: r.branch as string | null,
        pull: r.pull as number | null,
        onMain: r.onMain === 1,
        sha: r.sha as string,
        outcome: r.outcome as 'pass' | 'fail',
        at: r.at as number,
        url: r.url as string,
        failedJobs: r.outcome === 'fail' ? (jobsOf.get(`${r.runId}|${r.attempt}`) ?? []) : [],
      }),
    ),
    workflows: workflows!.results.map((r) => r.workflow as string),
    oldest: oldest!.results[0]!.oldest as number | null,
    redNow: redNowFrom(red as { results: Row[] }[]),
  };
  return { data, extra };
}
