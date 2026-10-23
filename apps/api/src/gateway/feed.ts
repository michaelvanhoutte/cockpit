import {
  CLAUDE_CALLS_FEED_PAGE,
  type ClaudeCall,
  type ClaudeCallsPage,
} from '@cockpit/shared/claude-calls-feed';
import type { Env } from '../env.js';
import { digest, sameDigest } from './receive.js';

/**
 * What the Harness Monitor reads Cockpit's Claude calls through ("Let the
 * Harness Monitor read Cockpit's Claude calls, without users, under a token of
 * its own", issue 1481): `GET /v1/usage-records`, the address staging and a
 * laptop POST their records to, answered to one more caller.
 *
 * **Outside the sign-in gate and outside the operator's secret**, like its
 * POST: the Monitor is a Worker with no session, and `BACKUP_TOKEN`, which
 * reads every account's data, must not be what opens it. `USAGE_READ_TOKEN`
 * opens this and nothing else, and none of the other tokens open it.
 */

/** Whether the request carries `USAGE_READ_TOKEN`; an unset token never matches. */
export async function readTokenAccepted(
  held: string | undefined,
  authorization: string | undefined,
): Promise<boolean> {
  const [scheme, ...rest] = (authorization ?? '').split(' ');
  const offered = rest.join(' ').trim();
  if (scheme?.toLowerCase() !== 'bearer' || !offered || !held) return false;
  return sameDigest(await digest(offered), await digest(held));
}

interface Row {
  id: number;
  at: string;
  environment: string;
  operation: string;
  prompt_version: string | null;
  triggered_by: string | null;
  model: string;
  outcome: ClaudeCall['outcome'];
  tokens_in: number | null;
  cache_read: number | null;
  cache_write: number | null;
  tokens_out: number | null;
  cost_usd: number | null;
  pull_request: number | null;
  run_id: number | null;
  branch: string | null;
}

/**
 * One page of the calls paid by Cockpit's Anthropic key, oldest first, after
 * the row numbered `after`.
 *
 * **Paged by the row's own number**, which production gives each row as it
 * inserts it: a row sent late from staging, local or CI gets a higher number
 * than any read so far and so is never skipped. **Whose money paid is the
 * row's own `paid_by`**, so a Workers AI call and a Claude Code routine's are
 * left out. **Only the columns the page shows are selected**: no user, account,
 * item or key detail is read, so none can be returned.
 */
export async function readClaudeCalls(env: Env, after: number): Promise<ClaudeCallsPage> {
  const { results } = await env.DB.prepare(
    `SELECT id, at, environment, operation, prompt_version, triggered_by, model, outcome,
            tokens_in, cache_read, cache_write, tokens_out, cost_usd, pull_request, run_id, branch
       FROM provider_calls
      WHERE id > ? AND paid_by = 'cockpit-anthropic-key'
      ORDER BY id
      LIMIT ?`,
  )
    .bind(after, CLAUDE_CALLS_FEED_PAGE + 1)
    .all<Row>();

  const calls = results.slice(0, CLAUDE_CALLS_FEED_PAGE).map(
    (row): ClaudeCall => ({
      id: row.id,
      at: row.at,
      environment: row.environment,
      feature: row.operation,
      promptVersion: row.prompt_version,
      startedBy: row.triggered_by,
      model: row.model,
      outcome: row.outcome,
      tokensIn: row.tokens_in,
      cacheRead: row.cache_read,
      cacheWrite: row.cache_write,
      tokensOut: row.tokens_out,
      costUsd: row.cost_usd,
      pullRequest: row.pull_request,
      runId: row.run_id,
      branch: row.branch,
    }),
  );
  return { calls, more: results.length > CLAUDE_CALLS_FEED_PAGE };
}
