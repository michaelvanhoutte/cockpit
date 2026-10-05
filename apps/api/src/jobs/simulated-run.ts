import type { Env } from '../env.js';
import { openAccount, AccountNotInRegisterError, NotFoundInAccountError } from '../accounts/index.js';
import type { SimulatedRunWaitsJob } from './enrichment.js';

/**
 * The guest account's simulated Claude Code runs ("Show agents at work in the
 * guest demo, with simulated runs", issue 774).
 *
 * **Decided by the account, not the Agent.** The guest's Agents - the seeded
 * four and any it makes - are ordinary `claude-code` Agents, and a start in
 * the guest account never reaches Claude: the start route (`http/app.ts`)
 * settles the run as working on a demo session address and asks for the step
 * below. The risk of that choice is a future engine path that skips the check
 * and fires for real.
 *
 * **The step to *waiting on you* is a delayed message on the enrichment
 * queue**, not work held open after the response, which a Worker cuts off
 * without a trace. The consumer applies the same change a Claude Code hook
 * does (`report_agent_run_activity`), so open tabs hear of it over SSE like any
 * other change. One message per run is the whole cost.
 */

/** How long after a start the run says Claude is waiting on you. */
export const SIMULATED_RUN_WAITS_AFTER_SECONDS = 15;

/** How long *Starting Claude…* shows before the run settles, where the environment names nothing. */
const DEFAULT_START_MS = 2000;
const LONGEST_START_MS = 10_000;

/** The pause on *Starting Claude…*: `SIMULATED_START_MS` where it holds a whole number within reason. */
export function startingPauseMs(configured: string | undefined): number {
  if (configured === undefined || !/^\d+$/.test(configured)) return DEFAULT_START_MS;
  return Math.min(Number(configured), LONGEST_START_MS);
}

/**
 * Asks for the run to move to *waiting on you* in about fifteen seconds. A
 * queue that will not take the message leaves the run *working*, which is
 * wrong only for a demo, so it is logged rather than failing the start.
 */
export async function enqueueSimulatedRunWaiting(
  env: Env,
  accountName: string,
  workspaceId: string,
  runId: string,
): Promise<void> {
  const job: SimulatedRunWaitsJob = { kind: 'simulated-run-waits', accountName, workspaceId, runId };
  try {
    await env.ENRICHMENT.send(job, { delaySeconds: SIMULATED_RUN_WAITS_AFTER_SECONDS });
  } catch (error) {
    console.error(
      JSON.stringify({
        level: 'error',
        message: `run ${runId} was not queued to move to waiting on you: ${
          error instanceof Error ? error.message : String(error)
        }`,
      }),
    );
  }
}

/**
 * Moves the run to *waiting on you*, only while it is still open: a run
 * marked Done in the meantime is ended, so the change finds nothing and moves
 * nothing, and one already waiting is the same report again, which the change
 * answers without writing. Everything this declines on is a return, so the
 * queue never redelivers it.
 */
export async function moveSimulatedRunToWaiting(env: Env, job: SimulatedRunWaitsJob): Promise<void> {
  try {
    const account = await openAccount(env, job.accountName);
    await account.applyChange('report_agent_run_activity', {
      commandId: crypto.randomUUID(),
      issuedAt: new Date().toISOString(),
      workspaceId: job.workspaceId,
      sessionIds: [job.runId],
      waiting: true,
    });
  } catch (error) {
    // The account left the register, or the Workspace went: nothing to move.
    if (error instanceof AccountNotInRegisterError || error instanceof NotFoundInAccountError) return;
    throw error;
  }
}
