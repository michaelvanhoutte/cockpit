import { belgianDaySql } from './belgium';
import { rebuildCallStatements } from './claude-calls';
import { currentPrices } from './price-list';
import { costMicros, priceOf } from './prices';
import { CREDITED_PHASES, PHASES_BEGIN_MS, requestPhaseSql, type Correction, type UsageRow } from './validate';

/** The phase a stored row counts as; a Building row before phase marks existed is Unphased. */
const PHASE = requestPhaseSql();

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
  cache_creation_1h_tokens, cost_micros, price_basis, priced_at, subagent_type, subagent_id
)
SELECT value ->> '$.requestId', value ->> '$.sessionId', value ->> '$.occurredAt', value ->> '$.day',
       value ->> '$.branch', value ->> '$.category', value ->> '$.reviewLevel', value ->> '$.model',
       value ->> '$.speed', value ->> '$.inputTokens', value ->> '$.outputTokens',
       value ->> '$.cacheCreationTokens', value ->> '$.cacheReadTokens', value ->> '$.subagent',
       value ->> '$.ranWhere', value ->> '$.source', ?2, ?3,
       value ->> '$.cacheCreation1hTokens', value ->> '$.costMicros', value ->> '$.priceBasis',
       CASE WHEN value ->> '$.costMicros' IS NULL THEN NULL ELSE ?3 END,
       value ->> '$.subagentType', value ->> '$.subagentId'
FROM json_each(?1) WHERE true
ORDER BY key
ON CONFLICT (request_id) DO NOTHING`;

/** Folds the rows one write stored into the totals. Reads only rows that write inserted. */
const ADD_TO_TOTALS = `INSERT INTO daily_totals (
  day, category, model, requests, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
  cost_micros, unpriced_requests
)
SELECT day, ${PHASE}, model, COUNT(*), SUM(input_tokens), SUM(output_tokens),
       SUM(cache_creation_tokens), SUM(cache_read_tokens),
       SUM(COALESCE(cost_micros, 0)), SUM(cost_micros IS NULL)
FROM usage_requests WHERE ingest_id = ?
GROUP BY day, ${PHASE}, model
ON CONFLICT (day, category, model) DO UPDATE SET
  requests = requests + excluded.requests,
  input_tokens = input_tokens + excluded.input_tokens,
  output_tokens = output_tokens + excluded.output_tokens,
  cache_creation_tokens = cache_creation_tokens + excluded.cache_creation_tokens,
  cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
  cost_micros = cost_micros + excluded.cost_micros,
  unpriced_requests = unpriced_requests + excluded.unpriced_requests`;

const CREDITED_TOTALS_COLUMNS = `day, branch, category, model, ran_where, subagent, credit_branch, requests, cost_micros, unpriced_requests,
  unpriced_input_tokens, unpriced_output_tokens, unpriced_cache_creation_tokens, unpriced_cache_read_tokens, last_at,
  input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens`;
/** The request rows `from` names, folded into totals; `credit` is the branch credited ('' under no credit). */
const CREDITED_TOTALS_SELECT = (day: string, credit: string, from: string) => `SELECT ${day}, COALESCE(branch, ''), ${PHASE}, model, ran_where, subagent, ${credit}, COUNT(*), SUM(COALESCE(cost_micros, 0)), SUM(cost_micros IS NULL),
       SUM(CASE WHEN cost_micros IS NULL THEN input_tokens ELSE 0 END),
       SUM(CASE WHEN cost_micros IS NULL THEN output_tokens ELSE 0 END),
       SUM(CASE WHEN cost_micros IS NULL THEN cache_creation_tokens ELSE 0 END),
       SUM(CASE WHEN cost_micros IS NULL THEN cache_read_tokens ELSE 0 END),
       MAX(occurred_at),
       SUM(input_tokens), SUM(output_tokens), SUM(cache_creation_tokens), SUM(cache_read_tokens)
FROM ${from}`;
const CREDITED_TOTALS_KEYS = (day: string, credit: string) => `${day}, COALESCE(branch, ''), ${PHASE}, model, ran_where, subagent, ${credit}`;
/**
 * The same rows folded into the totals the costs page reads: dollars and tokens by day, branch, phase, model, place, agent
 * and credited branch. A request arriving counts under no credit ('') until the nightly rebuild decides one.
 */
const ADD_TO_CREDITED_TOTALS = `INSERT INTO daily_credited_totals (${CREDITED_TOTALS_COLUMNS})
${CREDITED_TOTALS_SELECT('day', "''", 'usage_requests')} WHERE ingest_id = ?
GROUP BY ${CREDITED_TOTALS_KEYS('day', "''")}
ON CONFLICT (day, branch, category, model, ran_where, subagent, credit_branch) DO UPDATE SET
  requests = requests + excluded.requests,
  cost_micros = cost_micros + excluded.cost_micros,
  unpriced_requests = unpriced_requests + excluded.unpriced_requests,
  unpriced_input_tokens = unpriced_input_tokens + excluded.unpriced_input_tokens,
  unpriced_output_tokens = unpriced_output_tokens + excluded.unpriced_output_tokens,
  unpriced_cache_creation_tokens = unpriced_cache_creation_tokens + excluded.unpriced_cache_creation_tokens,
  unpriced_cache_read_tokens = unpriced_cache_read_tokens + excluded.unpriced_cache_read_tokens,
  last_at = MAX(last_at, excluded.last_at),
  input_tokens = input_tokens + excluded.input_tokens,
  output_tokens = output_tokens + excluded.output_tokens,
  cache_creation_tokens = cache_creation_tokens + excluded.cache_creation_tokens,
  cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens`;
const SESSION_START_COLUMNS = `session_id, request_id, occurred_at, day, branch, model, input_tokens, cache_creation_tokens, cache_read_tokens`;
/** Each session's earliest main-agent request among the rows `from` selects; the request id breaks a tie. */
const SESSION_STARTS_SELECT = (day: string, from: string) => `SELECT session_id, request_id, occurred_at, ${day}, COALESCE(branch, ''), model, input_tokens, cache_creation_tokens, cache_read_tokens
FROM (
  SELECT *, ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY occurred_at, request_id) AS n
  FROM usage_requests WHERE subagent = 0${from}
)
WHERE n = 1`;
/** A session's start keeps the earliest main-agent request, whatever order its requests arrive in. */
const ADD_TO_SESSION_STARTS = `INSERT INTO session_starts (${SESSION_START_COLUMNS})
${SESSION_STARTS_SELECT('day', ' AND ingest_id = ?')}
ON CONFLICT (session_id) DO UPDATE SET
  request_id = excluded.request_id, occurred_at = excluded.occurred_at, day = excluded.day, branch = excluded.branch,
  model = excluded.model, input_tokens = excluded.input_tokens,
  cache_creation_tokens = excluded.cache_creation_tokens, cache_read_tokens = excluded.cache_read_tokens
WHERE excluded.occurred_at < session_starts.occurred_at
   OR (excluded.occurred_at = session_starts.occurred_at AND excluded.request_id < session_starts.request_id)`;
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
    db.prepare(ADD_TO_CREDITED_TOTALS).bind(ingestId),
    db.prepare(ADD_TO_SESSION_STARTS).bind(ingestId),
  ]);
  const stored = inserted!.meta.changes ?? 0;
  return { stored, ignored: rows.length - stored };
}

/**
 * Places stored Unphased requests again, one batch in one statement (the JSON
 * array bound as a single parameter, as `storeBatch` does). Only a local row
 * still Unphased and dated on or after the moment phase marks began changes, so
 * a cloud session's rows stay Unphased even where its log was resumed here; the
 * category is one `validateCorrections` allowed. The totals are left alone: the
 * rebuild job derives them from the rows once the run is over.
 */
const CORRECT_ROWS = `UPDATE usage_requests SET category = c.value ->> '$.category'
FROM json_each(?1) AS c
WHERE usage_requests.request_id = c.value ->> '$.requestId'
  AND usage_requests.category = 'unphased'
  AND usage_requests.ran_where = 'local'
  AND usage_requests.occurred_at >= ?2`;

/** How many rows a batch of corrections changed, and how many it left as they were. */
export async function correctBatch(db: D1Database, corrections: Correction[]) {
  const result = await db.prepare(CORRECT_ROWS).bind(JSON.stringify(corrections), PHASES_BEGIN_MS).run();
  const changed = result.meta.changes ?? 0;
  return { changed, left: corrections.length - changed };
}

/** How many stored local requests dated on or after the moment phase marks began are still Unphased. */
export async function stillUnphased(db: D1Database): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM usage_requests WHERE occurred_at >= ?1 AND category = 'unphased' AND ran_where = 'local'`)
    .bind(PHASES_BEGIN_MS)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * Decides each request's credit, from every stored request and the branch links as they stand.
 *
 * A request in a process phase from a branch no pull request names is credited to the branch of the nearest request
 * in its own session whose branch has one: the next such request, else the last one before it. The window
 * orderings are the session's (time, then request id); the nearest request is the smallest (or, going back, the
 * largest) position among the linked ones, which a zero-padded position in front of the branch lets a plain MIN or MAX
 * pick out. Both windows only ever grow from one end of the session, so each is one pass.
 */
const DECIDE_CREDITS = `INSERT INTO request_credits (request_id, credit_branch)
SELECT request_id, substr(COALESCE(next_linked, last_linked), 21)
FROM (
  SELECT request_id, phase, linked,
    MIN(CASE WHEN linked THEN printf('%020d', n) || branch END)
      OVER (PARTITION BY session_id ORDER BY n DESC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS next_linked,
    MAX(CASE WHEN linked THEN printf('%020d', n) || branch END)
      OVER (PARTITION BY session_id ORDER BY n ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS last_linked
  FROM (
    SELECT u.request_id, u.session_id, u.branch, ${requestPhaseSql('u.')} AS phase, l.branch IS NOT NULL AS linked,
      ROW_NUMBER() OVER (PARTITION BY u.session_id ORDER BY u.occurred_at, u.request_id) AS n
    FROM usage_requests u LEFT JOIN branch_links l ON l.branch = u.branch
  )
)
WHERE NOT linked AND phase IN (${CREDITED_PHASES.map((p) => `'${p}'`).join(', ')})
  AND COALESCE(next_linked, last_linked) IS NOT NULL`;

/**
 * Throws the totals away and rebuilds them from the rows. Returns how many days they now cover.
 *
 * Every day is derived from the request's exact time, never from the day stored
 * on its row: rows stored before the Monitor counted in Belgian days carry a UTC
 * day, and rows stored since carry a Belgian one. Running it again, after a
 * failed run or a finished one, gives the same totals.
 *
 * It also decides which requests are credited to which linked branch (`request_credits`) and files the
 * totals under that credit, in the same batch, so the credit and the totals never disagree. It records the
 * moment linking last caught up as the moment the credit is good through (`link_state.credited_through`),
 * which is what keeps a branch reading "linking…" until a rebuild has seen its pull request.
 *
 * The same batch drops Cockpit's Claude calls copied more than 12 months
 * before `now` and rebuilds their totals from the copies left; it never deletes
 * a Claude Code request. Returns the days covered and the copies dropped.
 */
export async function rebuildTotals(db: D1Database, now = Date.now()): Promise<{ days: number; dropped: number }> {
  const day = belgianDaySql('occurred_at');
  const calls = rebuildCallStatements(db, now);
  const [dropped] = await db.batch([
    calls.drop,
    ...calls.rebuild,
    db.prepare('DELETE FROM daily_totals'),
    db.prepare('DELETE FROM daily_credited_totals'),
    db.prepare('DELETE FROM request_credits'),
    db.prepare('DELETE FROM session_starts'),
    db.prepare(`INSERT INTO daily_totals (
        day, category, model, requests, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
        cost_micros, unpriced_requests
      )
      SELECT ${day}, ${PHASE}, model, COUNT(*), SUM(input_tokens), SUM(output_tokens),
             SUM(cache_creation_tokens), SUM(cache_read_tokens),
             SUM(COALESCE(cost_micros, 0)), SUM(cost_micros IS NULL)
      FROM usage_requests GROUP BY ${day}, ${PHASE}, model`),
    db.prepare(DECIDE_CREDITS),
    db.prepare(`INSERT INTO daily_credited_totals (${CREDITED_TOTALS_COLUMNS})
      ${CREDITED_TOTALS_SELECT(day, "COALESCE(credit_branch, '')", 'usage_requests LEFT JOIN request_credits USING (request_id)')}
      GROUP BY ${CREDITED_TOTALS_KEYS(day, "COALESCE(credit_branch, '')")}`),
    db.prepare(`INSERT INTO session_starts (${SESSION_START_COLUMNS})
      ${SESSION_STARTS_SELECT(day, '')}`),
    db.prepare('UPDATE link_state SET credited_through = last_success_at WHERE id = 1'),
  ]);
  const covered = await db.prepare('SELECT COUNT(DISTINCT day) AS days FROM daily_totals').first<{ days: number }>();
  return { days: covered?.days ?? 0, dropped: dropped!.meta.changes ?? 0 };
}

export interface UnpricedLine {
  model: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  /** Distinct branches the requests ran on. */
  branches: number;
}

/** Requests without a price, per model: what the warning names. Read from the credited totals, never the rows. */
export async function unpricedLines(db: D1Database): Promise<UnpricedLine[]> {
  const { results } = await db
    .prepare(`SELECT model, SUM(unpriced_requests) AS requests, SUM(unpriced_input_tokens) AS inputTokens,
        SUM(unpriced_output_tokens) AS outputTokens, SUM(unpriced_cache_creation_tokens) AS cacheCreationTokens,
        SUM(unpriced_cache_read_tokens) AS cacheReadTokens,
        COUNT(DISTINCT CASE WHEN branch = '' THEN NULL ELSE branch END) AS branches
      FROM daily_credited_totals WHERE unpriced_requests > 0 GROUP BY model ORDER BY requests DESC, model`)
    .all<UnpricedLine>();
  return results;
}
