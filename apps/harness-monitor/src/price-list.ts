import { costMicros, LITELLM_URL, priceOf, readLiteLlm, withOverrides, type PriceList } from './prices';

export interface ListStatus {
  fetchedAt: number | null;
  lastAttemptAt: number | null;
  /** Why the last attempt failed; null when it succeeded or none was made. */
  lastError: string | null;
}

interface ListRow {
  models: string | null;
  fetched_at: number | null;
  last_attempt_at: number | null;
  last_error: string | null;
}

async function readRow(db: D1Database): Promise<ListRow | null> {
  return db.prepare('SELECT models, fetched_at, last_attempt_at, last_error FROM price_list WHERE id = 1').first<ListRow>();
}

/** The list requests are priced from now: the last good fetch, with the repository's prices over it. */
export async function currentPrices(db: D1Database): Promise<PriceList> {
  const row = await readRow(db);
  return withOverrides(row?.models ? (JSON.parse(row.models) as PriceList) : {});
}

export async function listStatus(db: D1Database): Promise<ListStatus> {
  const row = await readRow(db);
  return { fetchedAt: row?.fetched_at ?? null, lastAttemptAt: row?.last_attempt_at ?? null, lastError: row?.last_error ?? null };
}

/**
 * Fetches LiteLLM's file. A failed fetch, a bad status or a file that is not a
 * price list leaves the stored list as it was and records why. Never throws.
 */
export async function refreshPriceList(db: D1Database, now = Date.now()): Promise<void> {
  let list: PriceList | null = null;
  let error: string | null = null;
  try {
    const response = await fetch(LITELLM_URL, { signal: AbortSignal.timeout(20_000) });
    if (!response.ok) {
      error = `LiteLLM answered ${response.status}.`;
    } else {
      list = readLiteLlm(await response.json());
      if (!list) error = 'The fetched file is not a price list.';
    }
  } catch (cause) {
    error = `The fetch failed: ${cause instanceof Error ? cause.message : String(cause)}`.slice(0, 200);
  }

  if (list) {
    await db
      .prepare(`INSERT INTO price_list (id, models, fetched_at, last_attempt_at, last_error) VALUES (1, ?1, ?2, ?2, NULL)
        ON CONFLICT (id) DO UPDATE SET models = excluded.models, fetched_at = excluded.fetched_at,
          last_attempt_at = excluded.last_attempt_at, last_error = NULL`)
      .bind(JSON.stringify(list), now)
      .run();
  } else {
    await db
      .prepare(`INSERT INTO price_list (id, last_attempt_at, last_error) VALUES (1, ?1, ?2)
        ON CONFLICT (id) DO UPDATE SET last_attempt_at = excluded.last_attempt_at, last_error = excluded.last_error`)
      .bind(now, error)
      .run();
  }
}

/** Chunks per run, so one invocation stays inside D1's 50 queries on the free plan. */
const MAX_CHUNKS = 20;
const CHUNK = 1000;

interface WaitingRow {
  request_id: string;
  model: string;
  speed: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_creation_1h_tokens: number;
  cache_read_tokens: number;
}

/**
 * Prices the rows still without a cost whose model the list now covers. Rows
 * already priced are never touched, so a changed rate leaves their cost alone.
 * Returns how many it priced.
 */
export async function priceWaitingRows(db: D1Database, now = Date.now()): Promise<number> {
  const prices = await currentPrices(db);
  const { results: waiting } = await db
    .prepare('SELECT DISTINCT model FROM usage_requests WHERE cost_micros IS NULL')
    .all<{ model: string }>();
  const covered = waiting.map((w) => w.model).filter((m) => priceOf(prices, m) !== undefined);
  if (covered.length === 0) return 0;

  let priced = 0;
  let after = '';
  for (let chunk = 0; chunk < MAX_CHUNKS; chunk += 1) {
    const { results: rows } = await db
      .prepare(`SELECT request_id, model, speed, input_tokens, output_tokens, cache_creation_tokens,
          cache_creation_1h_tokens, cache_read_tokens
        FROM usage_requests
        WHERE cost_micros IS NULL AND request_id > ?1 AND model IN (SELECT value FROM json_each(?2))
        ORDER BY request_id LIMIT ?3`)
      .bind(after, JSON.stringify(covered), CHUNK)
      .all<WaitingRow>();
    if (rows.length === 0) break;
    after = rows[rows.length - 1]!.request_id;

    const costs = rows.flatMap((r) => {
      const cost = costMicros(priceOf(prices, r.model), r.speed, {
        input: r.input_tokens,
        output: r.output_tokens,
        cacheCreation: r.cache_creation_tokens,
        cacheCreation1h: r.cache_creation_1h_tokens,
        cacheRead: r.cache_read_tokens,
      });
      return cost === null ? [] : [{ id: r.request_id, cost }];
    });
    if (costs.length > 0) {
      await db
        .prepare(`UPDATE usage_requests SET cost_micros = j.value ->> '$.cost', price_basis = 'daily-job', priced_at = ?2
          FROM json_each(?1) AS j WHERE usage_requests.request_id = j.value ->> '$.id' AND usage_requests.cost_micros IS NULL`)
        .bind(JSON.stringify(costs), now)
        .run();
      priced += costs.length;
    }
    if (rows.length < CHUNK) break;
  }
  return priced;
}
