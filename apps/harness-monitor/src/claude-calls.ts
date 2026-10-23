import { belgianDaySql } from './belgium';
import { checkCallsPage, type ClaudeCall } from './claude-call-shape';

/**
 * The import of Cockpit's Claude calls ("Copy Cockpit's Claude calls into the
 * Harness Monitor every 12 hours, and drop them after 12 months", issue 1482):
 * production's route, read after the last row number copied, a capped number of
 * pages per run, stored in one batch.
 */

/** Production's route, on `COCKPIT_URL`. */
export const FEED_PATH = '/v1/usage-records';

/**
 * Most pages one run reads, each up to 1,000 calls. Each is a subrequest, and
 * each stores as one statement of the batch: with the place read, the batch's
 * two more statements and the run's record, a run makes at most 10 subrequests
 * and 14 queries of the 50 each that the Monitor's jobs are sized to
 * (docs/architecture.md, "The Harness Monitor"), and no bound page is near D1's
 * 2 MB a value.
 */
export const MAX_PAGES = 10;

/** How long a copy is kept, as production keeps its record. */
export const KEPT_MONTHS = 12;

export interface CallsEnv {
  DB: D1Database;
  /** A secret, the same value as on Cockpit's production. Unset, the import skips. */
  USAGE_READ_TOKEN?: string;
  /** Production's address, no path, set in wrangler.jsonc. Unset, the import skips. */
  COCKPIT_URL?: string;
}

export type ImportResult =
  | { status: 'skipped' }
  | { status: 'failed'; error: string }
  | { status: 'caught-up' | 'more-to-read'; copied: number; already: number };

/** Every call of a page in one statement, from a JSON array bound as one parameter (see store.ts); a call already copied is ignored. */
const INSERT_CALLS = `INSERT INTO claude_calls (
  id, occurred_at, environment, feature, prompt_version, started_by, model, outcome,
  tokens_in, cache_read, cache_write, tokens_out, cost_micros, pull_request, run_id, branch, ingest_id, copied_at
)
SELECT value ->> '$.id', value ->> '$.occurredAt', value ->> '$.environment', value ->> '$.feature',
       value ->> '$.promptVersion', value ->> '$.startedBy', value ->> '$.model', value ->> '$.outcome',
       value ->> '$.tokensIn', value ->> '$.cacheRead', value ->> '$.cacheWrite', value ->> '$.tokensOut',
       value ->> '$.costMicros', value ->> '$.pullRequest', value ->> '$.runId', value ->> '$.branch', ?2, ?3
FROM json_each(?1) WHERE true
ORDER BY key
ON CONFLICT (id) DO NOTHING`;

const DAY = belgianDaySql('occurred_at');
const TOTALS_KEYS = `${DAY}, environment, feature, model, COALESCE(started_by, ''), COALESCE(pull_request, 0), COALESCE(run_id, 0)`;
const TOTALS_SELECT = `SELECT ${TOTALS_KEYS}, COUNT(*), SUM(COALESCE(cost_micros, 0)), SUM(cost_micros IS NULL) FROM claude_calls`;
const TOTALS_COLUMNS = 'day, environment, feature, model, started_by, pull_request, run_id, calls, cost_micros, unpriced_calls';

/** Folds the copies one run inserted into the totals; a copy that lost to an earlier one keeps that run's id, so nothing counts twice. */
const ADD_TO_TOTALS = `INSERT INTO claude_call_daily_totals (${TOTALS_COLUMNS})
${TOTALS_SELECT} WHERE ingest_id = ?
GROUP BY ${TOTALS_KEYS}
ON CONFLICT (day, environment, feature, model, started_by, pull_request, run_id) DO UPDATE SET
  calls = calls + excluded.calls,
  cost_micros = cost_micros + excluded.cost_micros,
  unpriced_calls = unpriced_calls + excluded.unpriced_calls`;

/** The new place; an overlapping run that read less never moves it back. */
const SAVE_PLACE = `INSERT INTO claude_call_place (id, after_id) VALUES (1, ?1)
ON CONFLICT (id) DO UPDATE SET after_id = MAX(after_id, excluded.after_id)`;

/** One page from production, or a throw saying why not. */
async function readPage(env: Required<CallsEnv>, after: number): Promise<{ calls: ClaudeCall[]; more: boolean }> {
  const url = new URL(FEED_PATH, env.COCKPIT_URL);
  url.searchParams.set('after', String(after));
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { authorization: `Bearer ${env.USAGE_READ_TOKEN}`, 'user-agent': 'harness-monitor' },
      // Covers reading the body too.
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') throw new Error('Cockpit did not answer in time.');
    throw new Error(`Could not reach Cockpit: ${(error instanceof Error ? error.message : String(error)).replace(/\.$/, '')}.`);
  }
  if (response.status === 401) {
    await response.body?.cancel();
    throw new Error('Cockpit refused the read token (401).');
  }
  if (!response.ok) {
    const said = ((await response.json().catch(() => null)) as { error?: unknown } | null)?.error;
    throw new Error(`Cockpit answered ${response.status}${typeof said === 'string' ? `: ${said.slice(0, 100)}` : ''}.`);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') throw new Error('Cockpit did not answer in time.');
    throw new Error("Cockpit's answer is not JSON.");
  }
  const checked = checkCallsPage(body, after);
  if (!checked.ok) throw new Error(`Cockpit's answer is not a page of calls: ${checked.error}`);
  return checked;
}

/**
 * The 12-hourly job. Reads up to MAX_PAGES pages after the stored place, then
 * stores the copies, the totals they add and the new place in one batch, so a
 * run that fails anywhere, on any page, stores nothing and the next run reads
 * from the same place. The cost is production's, never priced here.
 */
export async function importClaudeCalls(env: CallsEnv, { now = Date.now() }: { now?: number } = {}): Promise<ImportResult> {
  if (!env.USAGE_READ_TOKEN || !env.COCKPIT_URL) {
    console.log("Importing Cockpit's Claude calls skipped: USAGE_READ_TOKEN or COCKPIT_URL is not set.");
    return { status: 'skipped' };
  }
  const ready = env as Required<CallsEnv>;
  try {
    const place = await env.DB.prepare('SELECT after_id AS after FROM claude_call_place WHERE id = 1').first<{ after: number }>();
    let after = place?.after ?? 0;
    const pages: ClaudeCall[][] = [];
    let more = true;
    while (more && pages.length < MAX_PAGES) {
      const page = await readPage(ready, after);
      more = page.more;
      if (page.calls.length === 0) break;
      pages.push(page.calls);
      after = page.calls.at(-1)!.id;
    }
    const read = pages.reduce((sum, calls) => sum + calls.length, 0);
    if (read === 0) return { status: 'caught-up', copied: 0, already: 0 };

    const ingestId = crypto.randomUUID();
    const results = await env.DB.batch([
      ...pages.map((calls) => env.DB.prepare(INSERT_CALLS).bind(JSON.stringify(calls), ingestId, now)),
      env.DB.prepare(ADD_TO_TOTALS).bind(ingestId),
      env.DB.prepare(SAVE_PLACE).bind(after),
    ]);
    const copied = results.slice(0, pages.length).reduce((sum, r) => sum + (r.meta.changes ?? 0), 0);
    return { status: more ? 'more-to-read' : 'caught-up', copied, already: read - copied };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Importing Cockpit's Claude calls failed, nothing changed: ${message}`);
    return { status: 'failed', error: message };
  }
}

/** The instant before which a copy is dropped: `KEPT_MONTHS` calendar months before `now`, as production cuts its own. */
export function keptFrom(now: number): number {
  const cutoff = new Date(now);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - KEPT_MONTHS);
  return cutoff.getTime();
}

/**
 * The rebuild's statements for the calls, to ride in its one batch, in this
 * order: `drop`, the copies older than 12 months, then `rebuild`, the totals
 * from what is left. The delete names only the copies; Claude Code's requests
 * are never touched.
 */
export const rebuildCallStatements = (db: D1Database, now: number) => ({
  drop: db.prepare('DELETE FROM claude_calls WHERE occurred_at < ?').bind(keptFrom(now)),
  rebuild: [
    db.prepare('DELETE FROM claude_call_daily_totals'),
    db.prepare(`INSERT INTO claude_call_daily_totals (${TOTALS_COLUMNS}) ${TOTALS_SELECT} GROUP BY ${TOTALS_KEYS}`),
  ],
});
