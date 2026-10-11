import type { UsageRow } from './validate';

/**
 * Inserts every row of a write in one statement, from a JSON array bound as a
 * single parameter: D1 counts each statement of a batch against the free plan's
 * 50 queries per invocation, and caps a statement at 100 bound parameters.
 * `WHERE true` is SQLite's required disambiguation of an upsert after a SELECT.
 */
const INSERT_ROWS = `INSERT INTO usage_requests (
  request_id, session_id, occurred_at, day, branch, category, review_level, model, speed,
  input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
  subagent, ran_where, source, ingest_id, received_at
)
SELECT value ->> '$.requestId', value ->> '$.sessionId', value ->> '$.occurredAt', value ->> '$.day',
       value ->> '$.branch', value ->> '$.category', value ->> '$.reviewLevel', value ->> '$.model',
       value ->> '$.speed', value ->> '$.inputTokens', value ->> '$.outputTokens',
       value ->> '$.cacheCreationTokens', value ->> '$.cacheReadTokens', value ->> '$.subagent',
       value ->> '$.ranWhere', value ->> '$.source', ?2, ?3
FROM json_each(?1) WHERE true
ORDER BY key
ON CONFLICT (request_id) DO NOTHING`;

/** Folds the rows one write stored into the totals. Reads only rows that write inserted. */
const ADD_TO_TOTALS = `INSERT INTO daily_totals (
  day, category, model, requests, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens
)
SELECT day, category, model, COUNT(*), SUM(input_tokens), SUM(output_tokens),
       SUM(cache_creation_tokens), SUM(cache_read_tokens)
FROM usage_requests WHERE ingest_id = ?
GROUP BY day, category, model
ON CONFLICT (day, category, model) DO UPDATE SET
  requests = requests + excluded.requests,
  input_tokens = input_tokens + excluded.input_tokens,
  output_tokens = output_tokens + excluded.output_tokens,
  cache_creation_tokens = cache_creation_tokens + excluded.cache_creation_tokens,
  cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens`;

/**
 * Stores the rows not stored yet and counts exactly those into the daily totals.
 *
 * One D1 batch is one transaction, and the totals are computed from the rows
 * this write's own id stamped - a row that lost to an earlier one keeps the
 * earlier write's id - so two overlapping writes can never count a request twice.
 */
export async function storeBatch(db: D1Database, rows: UsageRow[], now = Date.now()) {
  const ingestId = crypto.randomUUID();
  const payload = JSON.stringify(rows.map((r) => ({ ...r, subagent: r.subagent ? 1 : 0 })));
  const [inserted] = await db.batch([
    db.prepare(INSERT_ROWS).bind(payload, ingestId, now),
    db.prepare(ADD_TO_TOTALS).bind(ingestId),
  ]);
  const stored = inserted!.meta.changes ?? 0;
  return { stored, ignored: rows.length - stored };
}

/** Throws the totals away and rebuilds them from the rows. */
export async function rebuildTotals(db: D1Database) {
  await db.batch([
    db.prepare('DELETE FROM daily_totals'),
    db.prepare(`INSERT INTO daily_totals (
        day, category, model, requests, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens
      )
      SELECT day, category, model, COUNT(*), SUM(input_tokens), SUM(output_tokens),
             SUM(cache_creation_tokens), SUM(cache_read_tokens)
      FROM usage_requests GROUP BY day, category, model`),
  ]);
}

export interface DayLine {
  day: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

/** Tokens per day, newest first. */
export async function dailyLines(db: D1Database, limit = 90): Promise<DayLine[]> {
  const { results } = await db
    .prepare(`SELECT day, SUM(requests) AS requests, SUM(input_tokens) AS inputTokens,
        SUM(output_tokens) AS outputTokens, SUM(cache_creation_tokens) AS cacheCreationTokens,
        SUM(cache_read_tokens) AS cacheReadTokens
      FROM daily_totals GROUP BY day ORDER BY day DESC LIMIT ?`)
    .bind(limit)
    .all<DayLine>();
  return results;
}
