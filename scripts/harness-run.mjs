#!/usr/bin/env node
//
// `pnpm harness:run <linking|prices|rebuild>`: starts one of the Harness
// Monitor's jobs on the live Worker now and prints what it did (Start the
// Harness Monitor's jobs by hand, issue 1013). It is the code the schedule
// runs, so a run here proves the scheduled one. Needs HARNESS_MONITOR_URL and
// HARNESS_WRITE_KEY in the environment, as `pnpm harness:upload` does. Exits 1
// when the job failed or the monitor refused, 2 when the command is misused.
//

import { describeAnswer, planRun, unreachable } from './lib/harness-run.mjs';

// Linking can read up to 30 GitHub pages inside the one request.
const WAIT_MS = 5 * 60_000;

const plan = planRun(process.argv.slice(2), process.env);
if (plan.error) {
  console.error(plan.error);
  process.exit(2);
}

let result;
try {
  const response = await fetch(plan.url, {
    method: 'POST',
    headers: { authorization: `Bearer ${plan.key}` },
    signal: AbortSignal.timeout(WAIT_MS),
  });
  const body = await response.json().catch(() => null);
  result = describeAnswer(plan.job, response.status, body);
} catch (error) {
  result = { ok: false, line: unreachable(error) };
}
(result.ok ? console.log : console.error)(result.line);
process.exitCode = result.ok ? 0 : 1;
