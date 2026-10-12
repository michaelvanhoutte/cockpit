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
  return { job, url: new URL(`/v1/jobs/${job}`, env.HARNESS_MONITOR_URL), key: env.HARNESS_WRITE_KEY };
}

/** What the monitor answered, as one line and whether the job succeeded. */
export function describeAnswer(job, status, body) {
  if (status === 401) return { ok: false, line: 'The monitor refused the write key.' };
  if (status === 503) return { ok: false, line: 'The monitor has no write key set, so it starts nothing.' };
  if (typeof body?.message === 'string' && typeof body.ok === 'boolean') {
    return { ok: body.ok, line: `${job}: ${body.ok ? 'done' : 'failed'} - ${body.message}` };
  }
  const why = typeof body?.error === 'string' ? ` ${body.error}` : '';
  return { ok: false, line: `The monitor answered ${status}.${why}` };
}
