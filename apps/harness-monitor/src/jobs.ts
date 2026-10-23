import { importClaudeCalls, type CallsEnv } from './claude-calls';
import { linkBranches, type LinkEnv, type LinkOptions } from './linking';
import { hasFetchedList, priceWaitingRows, refreshPriceList } from './price-list';
import { rebuildTotals } from './store';

export const JOBS = ['linking', 'prices', 'rebuild', 'claude-calls'] as const;
export type JobName = (typeof JOBS)[number];
export type StartedBy = 'schedule' | 'hand';

/** What a job reads: the database, and what linking and the import of Cockpit's Claude calls each need. */
export type JobEnv = LinkEnv & CallsEnv;

/** Where a job's last run is recorded: job_runs' CHECK names the first three jobs, so a later one has a table of its own. */
const RUNS_TABLE: Record<JobName, string> = { linking: 'job_runs', prices: 'job_runs', rebuild: 'job_runs', 'claude-calls': 'claude_call_job_runs' };

export const isJob = (name: string): name is JobName => (JOBS as readonly string[]).includes(name);

export interface JobOutcome {
  ok: boolean;
  /** What the job did, or the error it met, as a sentence. */
  message: string;
  /** Set by `prices`: how many waiting requests the run priced, so a caller can run it again while it prices any. */
  priced?: number;
}

export interface JobRun extends JobOutcome {
  ranAt: number;
  startedBy: StartedBy;
}

/** What the page says of one job: its latest recorded run, if any, and when it last did its work. */
export interface JobStatus {
  job: JobName;
  /** Null for a deployment that predates the record: only `lastSucceededAt` is known then. */
  run: JobRun | null;
  lastSucceededAt: number | null;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

async function execute(env: JobEnv, job: JobName, now: number, full: boolean): Promise<JobOutcome> {
  if (job === 'claude-calls') {
    const run = await importClaudeCalls(env, { now });
    if (run.status === 'skipped') return { ok: false, message: 'Skipped: USAGE_READ_TOKEN or COCKPIT_URL is not set on the Worker.' };
    if (run.status === 'failed') return { ok: false, message: `${run.error} Nothing was copied.` };
    const copied = `Copied ${plural(run.copied, 'Claude call')}${run.already > 0 ? ` (${run.already} already here)` : ''}`;
    return { ok: true, message: run.status === 'caught-up' ? `${copied}; caught up with Cockpit.` : `${copied}; more to read — run it again.` };
  }
  if (job === 'linking') {
    const run = await linkBranches(env, { now, full });
    if (run.status === 'skipped') return { ok: false, message: 'Skipped: GITHUB_TOKEN or GITHUB_REPOSITORY is not set on the Worker.' };
    if (run.status === 'failed') return { ok: false, message: run.error };
    const restarted = run.restarted ? "GitHub no longer accepted linking's stored place; started again from the first pull request. " : '';
    const linked = `${restarted}Linked ${plural(run.linked, 'pull request')}`;
    if (run.status === 'place-moved') return { ok: true, message: `${linked}; another run moved linking's place, so this one stopped.` };
    if (run.status === 'caught-up') return { ok: true, message: `${linked}; caught up with GitHub.` };
    const stopped = run.timeout ? `${run.timeout}. More to read` : 'more to read';
    // A second full re-read would start over; a plain run carries on from here.
    return { ok: true, message: `${linked}; ${stopped} — run ${full ? 'linking again (a plain run continues from here)' : 'it again'}.` };
  }
  if (job === 'prices') {
    const refreshed = await refreshPriceList(env.DB, now);
    const priced = await priceWaitingRows(env.DB, now);
    // Pricing changes rows, not the totals the page reads: those wait for a rebuild.
    const waiting = `priced ${plural(priced, 'waiting request')}${priced > 0 ? '; run rebuild next so the page\'s dollars include them' : ''}`;
    if (refreshed.error === null) return { ok: true, message: `Fetched ${plural(refreshed.models, 'model price')}; ${waiting}.`, priced };
    const kept = (await hasFetchedList(env.DB)) ? 'The last good list is still in use' : 'Nothing is priced from it';
    return { ok: false, message: `${refreshed.error} ${kept}; ${waiting}.`, priced };
  }
  const { days, dropped } = await rebuildTotals(env.DB, now);
  const old = dropped > 0 ? `; dropped ${plural(dropped, 'Claude call')} older than 12 months` : '';
  return { ok: true, message: `Rebuilt the totals for ${plural(days, 'day')}${old}.` };
}

/**
 * Runs one job, the same code whoever starts it, and stores what it did as the
 * job's last run. A job that throws is a failed run, never a crashed Worker.
 * `full` restarts linking from the first pull request (see linkBranches).
 */
export async function runJob(env: JobEnv, job: JobName, startedBy: StartedBy, { now = Date.now(), full = false }: LinkOptions = {}): Promise<JobOutcome> {
  let outcome: JobOutcome;
  try {
    outcome = await execute(env, job, now, full);
  } catch (error) {
    outcome = { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
  try {
    // An older, slower run never replaces a newer record, but a success it records is never lost.
    const runs = RUNS_TABLE[job];
    const newer = `excluded.ran_at >= ${runs}.ran_at`;
    await env.DB
      .prepare(`INSERT INTO ${runs} (job, ran_at, started_by, ok, message, last_ok_at) VALUES (?1, ?2, ?3, ?4, ?5, CASE WHEN ?4 = 1 THEN ?2 END)
        ON CONFLICT (job) DO UPDATE SET
          ran_at = CASE WHEN ${newer} THEN excluded.ran_at ELSE ${runs}.ran_at END,
          started_by = CASE WHEN ${newer} THEN excluded.started_by ELSE ${runs}.started_by END,
          ok = CASE WHEN ${newer} THEN excluded.ok ELSE ${runs}.ok END,
          message = CASE WHEN ${newer} THEN excluded.message ELSE ${runs}.message END,
          last_ok_at = COALESCE(MAX(${runs}.last_ok_at, excluded.last_ok_at), ${runs}.last_ok_at, excluded.last_ok_at)`)
      .bind(job, now, startedBy, outcome.ok ? 1 : 0, outcome.message.slice(0, 300))
      .run();
  } catch (error) {
    console.error(`Could not record the ${job} run: ${error instanceof Error ? error.message : String(error)}`);
  }
  return outcome;
}

/** The reads `jobStatuses` needs, to ride in the page's one batch of reads. */
export const jobReads = (db: D1Database) => [
  db.prepare(`SELECT job, ran_at AS ranAt, started_by AS startedBy, ok, message, last_ok_at AS lastOkAt FROM job_runs
    UNION ALL SELECT job, ran_at, started_by, ok, message, last_ok_at FROM claude_call_job_runs`),
  db.prepare('SELECT fetched_at AS at FROM price_list WHERE id = 1'),
];

/**
 * Each job's status, in the order of JOBS. When it last succeeded is the run
 * record's own; before the first recorded success, what the job stored itself
 * (the link cursor's success time, the fetched list) stands in, so a deployment
 * that predates the record does not read as never run.
 */
export function jobStatuses(runs: D1Result, list: D1Result, linkedAt: number | null): JobStatus[] {
  const rows = runs.results as { job: JobName; ranAt: number; startedBy: StartedBy; ok: number; message: string; lastOkAt: number | null }[];
  const fetchedAt = (list.results[0] as { at: number | null } | undefined)?.at ?? null;
  const stored: Record<JobName, number | null> = { linking: linkedAt, prices: fetchedAt, rebuild: null, 'claude-calls': null };
  return JOBS.map((job) => {
    const row = rows.find((r) => r.job === job);
    return {
      job,
      run: row ? { ranAt: row.ranAt, startedBy: row.startedBy, ok: row.ok === 1, message: row.message } : null,
      lastSucceededAt: row?.lastOkAt ?? stored[job],
    };
  });
}
