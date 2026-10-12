#!/usr/bin/env node
//
// `pnpm harness:run <linking|prices|rebuild>`: starts one of the Harness
// Monitor's jobs on the live Worker now and prints what it did (Start the
// Harness Monitor's jobs by hand, issue 1013); `prices` repeats until nothing
// more is priced, then starts `rebuild` (issue 1021). It is the code the schedule
// runs, so a run here proves the scheduled one. Needs HARNESS_MONITOR_URL and
// HARNESS_WRITE_KEY in the environment, as `pnpm harness:upload` does. Exits 1
// when the job failed or the monitor refused, 2 when the command is misused.
//

import { describeAnswer, jobUrl, nextJob, planRun, unreachable } from './lib/harness-run.mjs';

// Linking can read up to 30 GitHub pages inside the one request.
const WAIT_MS = 5 * 60_000;

const plan = planRun(process.argv.slice(2), process.env);
if (plan.error) {
  console.error(plan.error);
  process.exit(2);
}

async function start(job) {
  try {
    const response = await fetch(jobUrl(job, plan.url), {
      method: 'POST',
      headers: { authorization: `Bearer ${plan.key}` },
      signal: AbortSignal.timeout(WAIT_MS),
    });
    const body = await response.json().catch(() => null);
    return { job, ...describeAnswer(job, response.status, body) };
  } catch (error) {
    return { job, ok: false, line: unreachable(error), priced: 0 };
  }
}

// `prices` repeats until a run prices nothing, then `rebuild` follows once.
for (let result = null, job = nextJob(plan.job, null); job; job = nextJob(plan.job, result)) {
  result = await start(job);
  (result.ok ? console.log : console.error)(result.line);
  if (!result.ok) {
    process.exitCode = 1;
    break;
  }
}
