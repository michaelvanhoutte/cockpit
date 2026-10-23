import type { Env } from '../env.js';
import type { AttemptRecord, Recorder } from './attempts.js';
import { costOf } from './prices.js';

/** How long a record is kept, the same as the sign-in history. */
const KEPT_MONTHS = 12;

/** The most rows one purge statement removes, so one night's backlog is several small writes rather than one large one. */
export const PURGE_BATCH = 500;

/**
 * Writes each record as one row of `provider_calls`, in one statement.
 *
 * **The user is looked up inside the insert**, from the register's one user
 * per account, so naming them costs no second round trip; a call for an
 * account nobody owns any more records no user. Nothing is copied from them
 * but the id, so a user deleted later leaves their rows naming an id alone.
 *
 * **Every row is priced as it is written**, from the price list deployed here
 * (`prices.ts`), and the cost is never worked out again. **Every row this
 * Worker writes is its own, so it is recorded as production's**, with no pull
 * request, run or branch.
 */
export function providerCallsIn(env: Env): Recorder {
  return async (row: AttemptRecord) => {
    await insert(env, row, 'production', { lookUpUserOf: row.accountName }, NO_PLACE);
  };
}

/**
 * Writes a record another environment sent, as that environment's own.
 *
 * **The user is the id it was sent with, and is never looked up here**: staging's
 * and a laptop's user ids are their own databases' (a local seed account shares
 * a name slug with a real person), so resolving one against production's users
 * would name somebody who made no call. **Priced here**, from production's own
 * price list, as a row it writes itself is.
 */
export async function recordReceived(
  env: Env,
  row: AttemptRecord,
  environment: 'staging' | 'ci' | 'local',
  userId: string | null,
  place: Place,
): Promise<void> {
  await insert(env, row, environment, { userId }, place);
}

/** Where a call outside production was made: the branch of a local checkout, or the pull request and run of a CI contract run. */
export interface Place {
  branch: string | null;
  pullRequest: number | null;
  runId: number | null;
}

const NO_PLACE: Place = { branch: null, pullRequest: null, runId: null };

type Whose = { lookUpUserOf: string } | { userId: string | null };

async function insert(
  env: Env,
  row: AttemptRecord,
  environment: string,
  whose: Whose,
  place: Place,
): Promise<void> {
  const looked = 'lookUpUserOf' in whose;
  await env.DB.prepare(
    `INSERT INTO provider_calls
       (at, operation, prompt_version, triggered_by, account_name, user_id, item_id, provider, model,
        paid_by, paid_by_account, paid_by_key_ending, outcome, status, duration_ms,
        tokens_in, cache_read, cache_write, tokens_out, environment, cost_usd, branch, pull_request, run_id)
     VALUES (?, ?, ?, ?, ?, ${
       looked ? '(SELECT id FROM users WHERE account_id = ? ORDER BY created_at LIMIT 1)' : '?'
     }, ?, ?, ?,
             ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      row.at,
      row.operation,
      row.promptVersion,
      row.triggeredBy,
      row.accountName,
      looked ? whose.lookUpUserOf : whose.userId,
      row.itemId,
      row.provider,
      row.model,
      row.paidBy.kind,
      row.paidBy.account,
      row.paidBy.keyEnding,
      row.outcome,
      row.outcome === 'error' ? row.status : null,
      Math.max(0, Math.round(row.durationMs)),
      row.tokensIn,
      row.cacheRead,
      row.cacheWrite,
      row.tokensOut,
      environment,
      costOf(row),
      place.branch,
      place.pullRequest,
      place.runId,
    )
    .run();
}

/**
 * Removes the records older than 12 months, from the nightly run, a batch at
 * a time until a batch comes back short. Each batch commits on its own, so a
 * run stopped midway leaves only rows that were already due, and repeating it
 * removes nothing more.
 */
export async function purgeOldProviderCalls(env: Env, now: Date, batch: number = PURGE_BATCH): Promise<void> {
  const cutoff = new Date(now);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - KEPT_MONTHS);
  for (;;) {
    const removed = await env.DB.prepare(
      'DELETE FROM provider_calls WHERE id IN (SELECT id FROM provider_calls WHERE at < ? ORDER BY at LIMIT ?)',
    )
      .bind(cutoff.toISOString(), batch)
      .run();
    if ((removed.meta.changes ?? 0) < batch) return;
  }
}
