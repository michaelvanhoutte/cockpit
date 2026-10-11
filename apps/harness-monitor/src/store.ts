import { currentPrices } from './price-list';
import { costMicros, priceOf } from './prices';
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
  subagent, ran_where, source, ingest_id, received_at,
  cache_creation_1h_tokens, cost_micros, price_basis, priced_at
)
SELECT value ->> '$.requestId', value ->> '$.sessionId', value ->> '$.occurredAt', value ->> '$.day',
       value ->> '$.branch', value ->> '$.category', value ->> '$.reviewLevel', value ->> '$.model',
       value ->> '$.speed', value ->> '$.inputTokens', value ->> '$.outputTokens',
       value ->> '$.cacheCreationTokens', value ->> '$.cacheReadTokens', value ->> '$.subagent',
       value ->> '$.ranWhere', value ->> '$.source', ?2, ?3,
       value ->> '$.cacheCreation1hTokens', value ->> '$.costMicros', value ->> '$.priceBasis',
       CASE WHEN value ->> '$.costMicros' IS NULL THEN NULL ELSE ?3 END
FROM json_each(?1) WHERE true
ORDER BY key
ON CONFLICT (request_id) DO NOTHING`;

/** Folds the rows one write stored into the totals. Reads only rows that write inserted. */
const ADD_TO_TOTALS = `INSERT INTO daily_totals (
  day, category, model, requests, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
  cost_micros, unpriced_requests
)
SELECT day, category, model, COUNT(*), SUM(input_tokens), SUM(output_tokens),
       SUM(cache_creation_tokens), SUM(cache_read_tokens),
       SUM(COALESCE(cost_micros, 0)), SUM(cost_micros IS NULL)
FROM usage_requests WHERE ingest_id = ?
GROUP BY day, category, model
ON CONFLICT (day, category, model) DO UPDATE SET
  requests = requests + excluded.requests,
  input_tokens = input_tokens + excluded.input_tokens,
  output_tokens = output_tokens + excluded.output_tokens,
  cache_creation_tokens = cache_creation_tokens + excluded.cache_creation_tokens,
  cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
  cost_micros = cost_micros + excluded.cost_micros,
  unpriced_requests = unpriced_requests + excluded.unpriced_requests`;

/**
 * Stores the rows not stored yet and counts exactly those into the daily totals.
 *
 * One D1 batch is one transaction, and the totals are computed from the rows
 * this write's own id stamped - a row that lost to an earlier one keeps the
 * earlier write's id - so two overlapping writes can never count a request twice.
 */
export async function storeBatch(db: D1Database, rows: UsageRow[], now = Date.now()) {
  const ingestId = crypto.randomUUID();
  const prices = await currentPrices(db);
  const payload = JSON.stringify(
    rows.map((r) => {
      const cost = costMicros(priceOf(prices, r.model), r.speed, {
        input: r.inputTokens,
        output: r.outputTokens,
        cacheCreation: r.cacheCreationTokens,
        cacheCreation1h: r.cacheCreation1hTokens,
        cacheRead: r.cacheReadTokens,
      });
      // Priced from the list current now, and kept; an upload says so.
      return { ...r, subagent: r.subagent ? 1 : 0, costMicros: cost, priceBasis: cost === null ? null : r.source === 'upload' ? 'upload' : 'arrival' };
    }),
  );
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
        day, category, model, requests, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
        cost_micros, unpriced_requests
      )
      SELECT day, category, model, COUNT(*), SUM(input_tokens), SUM(output_tokens),
             SUM(cache_creation_tokens), SUM(cache_read_tokens),
             SUM(COALESCE(cost_micros, 0)), SUM(cost_micros IS NULL)
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
  /** Dollars of the priced requests only, in millionths. */
  costMicros: number;
  unpricedRequests: number;
}

/** Tokens per day, newest first. */
export async function dailyLines(db: D1Database, limit = 90): Promise<DayLine[]> {
  const { results } = await db
    .prepare(`SELECT day, SUM(requests) AS requests, SUM(input_tokens) AS inputTokens,
        SUM(output_tokens) AS outputTokens, SUM(cache_creation_tokens) AS cacheCreationTokens,
        SUM(cache_read_tokens) AS cacheReadTokens, SUM(cost_micros) AS costMicros,
        SUM(unpriced_requests) AS unpricedRequests
      FROM daily_totals GROUP BY day ORDER BY day DESC LIMIT ?`)
    .bind(limit)
    .all<DayLine>();
  return results;
}

export interface UnpricedLine {
  model: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  /** Distinct branches the requests ran on. Pull requests are not linked yet, so a branch is what there is to count. */
  branches: number;
}

/** Requests without a price, per model: what the warning names. Read from the rows, which are few while unpriced. */
export async function unpricedLines(db: D1Database): Promise<UnpricedLine[]> {
  const { results } = await db
    .prepare(`SELECT model, COUNT(*) AS requests, SUM(input_tokens) AS inputTokens, SUM(output_tokens) AS outputTokens,
        SUM(cache_creation_tokens) AS cacheCreationTokens, SUM(cache_read_tokens) AS cacheReadTokens,
        COUNT(DISTINCT branch) AS branches
      FROM usage_requests WHERE cost_micros IS NULL GROUP BY model ORDER BY requests DESC, model`)
    .all<UnpricedLine>();
  return results;
}
