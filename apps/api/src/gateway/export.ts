import { USAGE_EXPORT_PAGE, type UsageExportPage, type UsageRecord } from '@cockpit/shared';
import type { Env } from '../env.js';

interface Joined {
  id: number;
  at: string;
  operation: string;
  prompt_version: string | null;
  triggered_by: string | null;
  user_id: string | null;
  user_name: string | null;
  provider: string;
  model: string;
  paid_by: string;
  paid_by_account: string | null;
  paid_by_key_ending: string | null;
  outcome: UsageRecord['outcome'];
  status: number | null;
  duration_ms: number;
  tokens_in: number | null;
  cache_read: number | null;
  cache_write: number | null;
  tokens_out: number | null;
  item_id: string | null;
}

/**
 * One page of the records from `since` on, oldest first, continuing after the
 * record numbered `after`.
 *
 * **Paged by the row's own number rather than by an offset**, so a record
 * written while the export runs can neither shift a page nor be read twice; it
 * joins the end. **Names come from a join that keeps the row when the user is
 * gone**: a deleted user's records export with their id and no name.
 */
export async function readUsageRecords(env: Env, since: string, after: number): Promise<UsageExportPage> {
  const { results } = await env.DB.prepare(
    `SELECT c.id, c.at, c.operation, c.prompt_version, c.triggered_by, c.user_id, u.name AS user_name,
            c.provider, c.model, c.paid_by, c.paid_by_account, c.paid_by_key_ending, c.outcome, c.status,
            c.duration_ms, c.tokens_in, c.cache_read, c.cache_write, c.tokens_out, c.item_id
       FROM provider_calls c
       LEFT JOIN users u ON u.id = c.user_id
      WHERE c.at >= ? AND c.id > ?
      ORDER BY c.id
      LIMIT ?`,
  )
    .bind(since, after, USAGE_EXPORT_PAGE + 1)
    .all<Joined>();

  const more = results.length > USAGE_EXPORT_PAGE;
  const records = results.slice(0, USAGE_EXPORT_PAGE).map(
    (row): UsageRecord => ({
      id: row.id,
      at: row.at,
      operation: row.operation,
      promptVersion: row.prompt_version,
      triggeredBy: row.triggered_by,
      userId: row.user_id,
      userName: row.user_name ?? '',
      provider: row.provider,
      model: row.model,
      paidBy: row.paid_by,
      paidByAccount: row.paid_by_account,
      paidByKeyEnding: row.paid_by_key_ending,
      outcome: row.outcome,
      status: row.status,
      durationMs: row.duration_ms,
      tokensIn: row.tokens_in,
      cacheRead: row.cache_read,
      cacheWrite: row.cache_write,
      tokensOut: row.tokens_out,
      itemId: row.item_id,
    }),
  );
  return { records, next: more ? records[records.length - 1]!.id : null };
}
