import { startOfDay } from './belgium';
import type { CallsQuery } from './claude-calls-page';
import { firstDay } from './costs';
import { csvStream, EXPORT_PAGE_SIZE, line } from './export';

/**
 * The copied calls under the page's period, environment, feature and model, one
 * line each, oldest first, as a stream read a keyset page at a time (see
 * exportCsv). The period is cut on the call's exact time, never on a day.
 * Columns are fixed, and none can name a person: the copies hold no user,
 * account or item, and the import refuses a page that carries one.
 */
const HEADER = [
  'time',
  'environment',
  'feature',
  'prompt_version',
  'started_by',
  'model',
  'outcome',
  'input_tokens',
  'output_tokens',
  'cache_read_tokens',
  'cache_write_tokens',
  'cost_usd',
  'pull_request',
  'run_id',
  'branch',
];

interface CallRow {
  id: number;
  occurred_at: number;
  environment: string;
  feature: string;
  prompt_version: string | null;
  started_by: string | null;
  model: string;
  outcome: string;
  tokens_in: number | null;
  tokens_out: number | null;
  cache_read: number | null;
  cache_write: number | null;
  cost_micros: number | null;
  pull_request: number | null;
  run_id: number | null;
  branch: string | null;
}

/** A call with no price has no cost here, never a zero one. */
const csvLine = (r: CallRow) =>
  line([
    new Date(r.occurred_at).toISOString(),
    r.environment,
    r.feature,
    r.prompt_version,
    r.started_by,
    r.model,
    r.outcome,
    r.tokens_in,
    r.tokens_out,
    r.cache_read,
    r.cache_write,
    r.cost_micros === null ? null : (r.cost_micros / 1e6).toFixed(6),
    r.pull_request,
    r.run_id,
    r.branch,
  ]);

export function exportClaudeCalls(db: D1Database, query: CallsQuery, now = Date.now()): Response {
  const where: string[] = [];
  const binds: (string | number)[] = [];
  const first = firstDay(query.period, now);
  if (first !== null) {
    where.push('occurred_at >= ?');
    binds.push(startOfDay(first));
  }
  if (query.environment !== null) {
    where.push('environment = ?');
    binds.push(query.environment);
  }
  if (query.feature !== null) {
    where.push('feature = ?');
    binds.push(query.feature);
  }
  if (query.model !== null) {
    where.push('model = ?');
    binds.push(query.model);
  }
  const base = `SELECT id, occurred_at, environment, feature, prompt_version, started_by, model, outcome, tokens_in, tokens_out,
      cache_read, cache_write, cost_micros, pull_request, run_id, branch FROM claude_calls`;
  const firstPage = `${base} ${where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`} ORDER BY occurred_at, id LIMIT ${EXPORT_PAGE_SIZE}`;
  const after = `${base} WHERE ${[...where, '(occurred_at, id) > (?, ?)'].join(' AND ')} ORDER BY occurred_at, id LIMIT ${EXPORT_PAGE_SIZE}`;

  const body = csvStream<[number, number]>(HEADER, EXPORT_PAGE_SIZE, async (cursor) => {
    const statement = cursor === null ? db.prepare(firstPage).bind(...binds) : db.prepare(after).bind(...binds, ...cursor);
    const { results } = await statement.all<CallRow>();
    const last = results[results.length - 1];
    return { text: results.map(csvLine).join(''), count: results.length, cursor: last ? [last.occurred_at, last.id] : cursor };
  });
  return new Response(body, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': 'attachment; filename="cockpit-claude-calls.csv"',
      'cache-control': 'no-store',
    },
  });
}
