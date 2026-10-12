import { linkBranches, type LinkEnv } from './linking';
import { hasFetchedList, priceWaitingRows, refreshPriceList } from './price-list';
import { rebuildTotals } from './store';

export const JOBS = ['linking', 'prices', 'rebuild'] as const;
export type JobName = (typeof JOBS)[number];
export type StartedBy = 'schedule' | 'hand';

export const isJob = (name: string): name is JobName => (JOBS as readonly string[]).includes(name);

export interface JobOutcome {
  ok: boolean;
  /** What the job did, or the error it met, as a sentence. */
  message: string;
}

export interface JobRun extends JobOutcome {
  job: JobName;
  ranAt: number;
  startedBy: StartedBy;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

async function execute(env: LinkEnv, job: JobName, now: number): Promise<JobOutcome> {
  if (job === 'linking') {
    const run = await linkBranches(env, now);
    if (run.status === 'skipped') return { ok: false, message: 'Skipped: GITHUB_TOKEN or GITHUB_REPOSITORY is not set on the Worker.' };
    if (run.status === 'failed') return { ok: false, message: run.error };
    const linked = `Linked ${plural(run.linked, 'pull request')}`;
    return { ok: true, message: run.status === 'caught-up' ? `${linked}; caught up with GitHub.` : `${linked}; more are left to read.` };
  }
  if (job === 'prices') {
    const refreshed = await refreshPriceList(env.DB, now);
    const priced = await priceWaitingRows(env.DB, now);
    const waiting = `priced ${plural(priced, 'waiting request')}`;
    if (refreshed.error === null) return { ok: true, message: `Fetched ${plural(refreshed.models, 'model price')}; ${waiting}.` };
    const kept = (await hasFetchedList(env.DB)) ? 'the last good list is still in use' : 'nothing is priced from it';
    return { ok: false, message: `${refreshed.error} ${kept[0]!.toUpperCase()}${kept.slice(1)}; ${waiting}.` };
  }
  const days = await rebuildTotals(env.DB);
  return { ok: true, message: `Rebuilt the totals for ${plural(days, 'day')}.` };
}

/**
 * Runs one job, the same code whoever starts it, and stores what it did as the
 * job's last run. A job that throws is a failed run, never a crashed Worker.
 */
export async function runJob(env: LinkEnv, job: JobName, startedBy: StartedBy, now = Date.now()): Promise<JobOutcome> {
  let outcome: JobOutcome;
  try {
    outcome = await execute(env, job, now);
  } catch (error) {
    outcome = { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
  await env.DB
    .prepare(`INSERT INTO job_runs (job, ran_at, started_by, ok, message) VALUES (?1, ?2, ?3, ?4, ?5)
      ON CONFLICT (job) DO UPDATE SET ran_at = excluded.ran_at, started_by = excluded.started_by,
        ok = excluded.ok, message = excluded.message`)
    .bind(job, now, startedBy, outcome.ok ? 1 : 0, outcome.message.slice(0, 300))
    .run();
  return outcome;
}

/** Each job's last run, in the order of JOBS; a job that has never run is absent. */
export async function lastRuns(db: D1Database): Promise<JobRun[]> {
  const { results } = await db
    .prepare('SELECT job, ran_at AS ranAt, started_by AS startedBy, ok, message FROM job_runs')
    .all<{ job: JobName; ranAt: number; startedBy: StartedBy; ok: number; message: string }>();
  return JOBS.flatMap((job) => {
    const row = results.find((r) => r.job === job);
    return row ? [{ ...row, ok: row.ok === 1 }] : [];
  });
}
