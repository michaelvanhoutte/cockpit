//
// The pure half of `pnpm harness:run`: which job and where from the arguments
// and environment, and an answer from the Harness Monitor in words. The I/O is
// scripts/harness-run.mjs.
//

export const JOBS = ['linking', 'prices', 'rebuild'];

/** The job, the address and the key to start it with, or the one thing that is missing. */
export function planRun(args, env) {
  const job = args[0];
  if (!JOBS.includes(job)) return { error: `Name the job to start: ${JOBS.join(', ')}.` };
  const missing = ['HARNESS_MONITOR_URL', 'HARNESS_WRITE_KEY'].filter((name) => !env[name]);
  if (missing.length > 0) return { error: `Set ${missing.join(' and ')} first (docs/deployment.md, "Where the usage hook finds the key").` };
  return { job, url: jobUrl(job, env.HARNESS_MONITOR_URL), key: env.HARNESS_WRITE_KEY };
}

export const jobUrl = (job, monitor) => new URL(`/v1/jobs/${job}`, monitor);

/**
 * The job to start after `previous` (null before the first), or null to stop.
 * `prices` repeats while a run priced something, since one run is capped; once
 * a run prices nothing, `rebuild` follows once. A failed run ends everything,
 * and an answer without a count (an older Worker) counts as nothing priced.
 */
export function nextJob(requested, previous) {
  if (previous === null) return requested;
  if (!previous.ok || requested !== 'prices' || previous.job !== 'prices') return null;
  return previous.priced > 0 ? 'prices' : 'rebuild';
}

/** Why no answer came: a timeout leaves the job possibly still running, so the page is where to look. */
export function unreachable(error) {
  if (error?.name === 'TimeoutError') return 'No answer within 5 minutes; the job may still be running. Check the costs page for its last run.';
  return `Could not reach the monitor: ${error instanceof Error ? error.message : String(error)}`;
}

/** What the monitor answered, as one line, whether the job succeeded and how many requests it priced. */
export function describeAnswer(job, status, body) {
  if (status === 401) return { ok: false, line: 'The monitor refused the write key.' };
  if (status === 503) return { ok: false, line: 'The monitor has no write key set, so it starts nothing.' };
  if (typeof body?.message === 'string' && typeof body.ok === 'boolean') {
    const priced = Number.isInteger(body.priced) && body.priced > 0 ? body.priced : 0;
    return { ok: body.ok, line: `${job}: ${body.ok ? 'done' : 'failed'} - ${body.message}`, priced };
  }
  const why = typeof body?.error === 'string' ? ` ${body.error}` : '';
  return { ok: false, line: `The monitor answered ${status}.${why}` };
}
