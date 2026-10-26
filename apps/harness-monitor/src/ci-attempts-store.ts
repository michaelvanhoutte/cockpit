import type { CiAttempt } from './ci-attempts';

const bit = (value: boolean) => (value ? 1 : 0);

// Each insert reads one JSON array whose objects are named as the columns are,
// so a send is a handful of statements whatever it holds.
const INSERT_ATTEMPTS = `INSERT INTO ci_attempts (run_id, attempt, workflow, path, event, branch, pull_number, on_main, head_sha, status, conclusion, outcome, created_at, url, received_at)
SELECT value ->> '$.run_id', value ->> '$.attempt', value ->> '$.workflow', value ->> '$.path', value ->> '$.event', value ->> '$.branch',
       value ->> '$.pull_number', value ->> '$.on_main', value ->> '$.head_sha', value ->> '$.status', value ->> '$.conclusion',
       value ->> '$.outcome', value ->> '$.created_at', value ->> '$.url', ?2
FROM json_each(?1) WHERE true
ON CONFLICT (run_id, attempt) DO UPDATE SET
  workflow = excluded.workflow, path = excluded.path, event = excluded.event, branch = excluded.branch, pull_number = COALESCE(excluded.pull_number, ci_attempts.pull_number),
  on_main = excluded.on_main, head_sha = excluded.head_sha, status = excluded.status, conclusion = excluded.conclusion,
  outcome = excluded.outcome, created_at = excluded.created_at, url = excluded.url, received_at = excluded.received_at`;

const INSERT_JOBS = `INSERT INTO ci_attempt_jobs (run_id, attempt, job_index, name, status, conclusion, outcome, started_at, completed_at, duration_ms, failed_step, url)
SELECT value ->> '$.runId', value ->> '$.attempt', value ->> '$.jobIndex', value ->> '$.name', value ->> '$.status', value ->> '$.conclusion',
       value ->> '$.outcome', value ->> '$.startedAt', value ->> '$.completedAt', value ->> '$.durationMs', value ->> '$.failedStep', value ->> '$.url'
FROM json_each(?1)`;

const INSERT_STEPS = `INSERT INTO ci_attempt_steps (run_id, attempt, job_index, position, number, name, occurrence, conclusion, started_at, completed_at, duration_ms)
SELECT value ->> '$.runId', value ->> '$.attempt', value ->> '$.jobIndex', value ->> '$.position', value ->> '$.number', value ->> '$.name',
       value ->> '$.occurrence', value ->> '$.conclusion', value ->> '$.startedAt', value ->> '$.completedAt', value ->> '$.durationMs'
FROM json_each(?1)`;

const INSERT_FAILED_JOBS = `INSERT INTO ci_failed_jobs (run_id, attempt, position, name, step, url, tests_more)
SELECT value ->> '$.runId', value ->> '$.attempt', value ->> '$.position', value ->> '$.name', value ->> '$.step', value ->> '$.url', value ->> '$.testsMore'
FROM json_each(?1)`;

const INSERT_FAILED_TESTS = `INSERT INTO ci_failed_tests (run_id, attempt, position, test_index, file, name, project, error)
SELECT value ->> '$.runId', value ->> '$.attempt', value ->> '$.position', value ->> '$.testIndex', value ->> '$.file', value ->> '$.name',
       value ->> '$.project', value ->> '$.error'
FROM json_each(?1)`;

/** The attempts a delete names: each under its own run, so one attempt re-sent never takes another's rows. */
const SENT = `(run_id, attempt) IN (SELECT value ->> '$.runId', value ->> '$.attempt' FROM json_each(?1))`;

/**
 * Stores a send's attempts, each replacing the attempt stored under its run and
 * number with every job, step, failed job and failed test beneath it, so a
 * re-send or an overlapping one never doubles a row and a later verdict wins.
 * One D1 batch, one transaction: a send lands whole or not at all, in nine
 * statements whatever its size.
 */
export async function storeAttempts(db: D1Database, attempts: CiAttempt[], now = Date.now()): Promise<{ stored: number }> {
  const keys = JSON.stringify(attempts.map((a) => ({ runId: a.runId, attempt: a.attempt })));
  const rows = attempts.map((a) => ({
    run_id: a.runId, attempt: a.attempt, workflow: a.workflow, path: a.path, event: a.event, branch: a.branch, pull_number: a.pullRequest,
    on_main: bit(a.onMain), head_sha: a.headSha, status: a.status, conclusion: a.conclusion, outcome: a.outcome, created_at: a.createdAt, url: a.url,
  }));
  const jobs = attempts.flatMap((a) => a.jobs.map(({ steps: _steps, ...job }) => ({ ...job, runId: a.runId, attempt: a.attempt })));
  const steps = attempts.flatMap((a) =>
    a.jobs.flatMap((j) => j.steps.map((s) => ({ ...s, runId: a.runId, attempt: a.attempt, jobIndex: j.jobIndex }))),
  );
  const failedJobs = attempts.flatMap((a) =>
    a.failedJobs.map((f, position) => ({ runId: a.runId, attempt: a.attempt, position, name: f.name, step: f.step, url: f.url, testsMore: f.testsMore })),
  );
  const failedTests = attempts.flatMap((a) =>
    a.failedJobs.flatMap((f, position) =>
      f.tests.map((t, testIndex) => ({ runId: a.runId, attempt: a.attempt, position, testIndex, file: t.file, name: t.name, project: t.project, error: t.error })),
    ),
  );
  await db.batch([
    db.prepare(`DELETE FROM ci_failed_tests WHERE ${SENT}`).bind(keys),
    db.prepare(`DELETE FROM ci_failed_jobs WHERE ${SENT}`).bind(keys),
    db.prepare(`DELETE FROM ci_attempt_steps WHERE ${SENT}`).bind(keys),
    db.prepare(`DELETE FROM ci_attempt_jobs WHERE ${SENT}`).bind(keys),
    db.prepare(INSERT_ATTEMPTS).bind(JSON.stringify(rows), now),
    db.prepare(INSERT_JOBS).bind(JSON.stringify(jobs)),
    db.prepare(INSERT_STEPS).bind(JSON.stringify(steps)),
    db.prepare(INSERT_FAILED_JOBS).bind(JSON.stringify(failedJobs)),
    db.prepare(INSERT_FAILED_TESTS).bind(JSON.stringify(failedTests)),
  ]);
  return { stored: attempts.length };
}

/** Which attempts a read of the newest asks about: main's, or every other branch's. */
export type AttemptScope = 'main' | 'branches';

export function parseScope(raw: string | null): AttemptScope | null {
  return raw === null || raw === 'main' ? 'main' : raw === 'branches' ? 'branches' : null;
}

/** When the newest stored attempt of the scope started, as ISO time, or null when none is stored: where the next send starts reading. */
export async function newestAttempt(db: D1Database, scope: AttemptScope): Promise<string | null> {
  const row = await db.prepare('SELECT MAX(created_at) AS newest FROM ci_attempts WHERE on_main = ?1').bind(scope === 'main' ? 1 : 0).first<{ newest: number | null }>();
  return row?.newest == null ? null : new Date(row.newest).toISOString();
}
