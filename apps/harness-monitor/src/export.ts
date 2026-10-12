import { firstDay, UNATTRIBUTED, type CostQuery } from './costs';

/**
 * Rows read per D1 query. The free plan allows 50 queries per invocation, so a
 * year's 600,000 requests need 30 of them at this size; each page is a few
 * megabytes, which a Worker holds without strain.
 */
export const EXPORT_PAGE_SIZE = 20_000;

/** The request rows a question keeps: the same day, category and engineer rules the page's totals apply, and one pull request if asked. */
export function requestFilter(query: CostQuery, pullRequest: number | null, now = Date.now()): { where: string; binds: (string | number)[] } {
  const where: string[] = [];
  const binds: (string | number)[] = [];
  const first = firstDay(query.period, now);
  if (first !== null) {
    where.push('u.day >= ?');
    binds.push(first);
  }
  if (query.category !== null) {
    where.push('u.category = ?');
    binds.push(query.category);
  }
  if (query.model !== null) {
    where.push('u.model = ?');
    binds.push(query.model);
  }
  if (query.who !== 'all') where.push(`u.subagent = ${query.who === 'subagents' ? 1 : 0}`);
  if (query.engineer === UNATTRIBUTED) where.push('l.branch IS NULL');
  else if (query.engineer !== null) {
    where.push('l.engineer = ?');
    binds.push(query.engineer);
  }
  if (pullRequest !== null) {
    where.push('l.pr_number = ?');
    binds.push(pullRequest);
  }
  return { where: where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`, binds };
}

const HEADER = [
  'time',
  'session',
  'branch',
  'pull_request',
  'issue',
  'engineer',
  'category',
  'model',
  'speed',
  'ran_where',
  'input_tokens',
  'output_tokens',
  'cache_creation_tokens',
  'cache_read_tokens',
  'cost_usd',
  'pricing',
];

/** One cell: quoted where it must be, and defused where a spreadsheet would read it as a formula. */
export function cell(value: string | number | null): string {
  if (value === null) return '';
  let text = String(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const line = (cells: (string | number | null)[]) => `${cells.map(cell).join(',')}\r\n`;

interface RequestRow {
  occurred_at: number;
  request_id: string;
  session_id: string;
  branch: string | null;
  prNumber: number | null;
  issue: number | null;
  engineer: string | null;
  category: string;
  model: string;
  speed: string;
  ran_where: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  cost_micros: number | null;
  price_basis: string | null;
}

/** Unpriced requests have no cost, never a zero one. */
const pricing = (r: RequestRow) => (r.cost_micros === null ? 'unpriced' : r.price_basis === 'upload' ? 'priced at upload' : 'priced');

function csvLine(r: RequestRow): string {
  return line([
    new Date(r.occurred_at).toISOString(),
    r.session_id,
    r.branch,
    r.prNumber,
    r.issue,
    r.engineer,
    r.category,
    r.model,
    r.speed,
    r.ran_where,
    r.input_tokens,
    r.output_tokens,
    r.cache_creation_tokens,
    r.cache_read_tokens,
    r.cost_micros === null ? null : (r.cost_micros / 1e6).toFixed(6),
    pricing(r),
  ]);
}

/**
 * The requests the question keeps, one line each, oldest first, as a stream:
 * the rows are read a keyset page at a time as the response is consumed, so a
 * year of them is never held at once and the response starts at once. Columns
 * are fixed, and none of them can hold an email address or conversation text:
 * the table does not store either.
 */
export function exportCsv(db: D1Database, query: CostQuery, pullRequest: number | null, filename: string, now = Date.now()): Response {
  const { where, binds } = requestFilter(query, pullRequest, now);
  const base = `SELECT u.occurred_at, u.request_id, u.session_id, u.branch, l.pr_number AS prNumber, l.issue_number AS issue,
      l.engineer AS engineer, u.category, u.model, u.speed, u.ran_where, u.input_tokens, u.output_tokens,
      u.cache_creation_tokens, u.cache_read_tokens, u.cost_micros, u.price_basis
    FROM ${
      // One pull request starts from its few branches and reads their rows through usage_requests_branch;
      // left to itself the planner walks every request in time order to honour the ORDER BY.
      pullRequest === null
        ? 'usage_requests u LEFT JOIN branch_links l'
        : 'branch_links l CROSS JOIN usage_requests u'
    } ON l.branch = u.branch`;
  const first = `${base} ${where} ORDER BY u.occurred_at, u.request_id LIMIT ${EXPORT_PAGE_SIZE}`;
  const after = `${base} ${where === '' ? 'WHERE' : `${where} AND`} (u.occurred_at, u.request_id) > (?, ?)
    ORDER BY u.occurred_at, u.request_id LIMIT ${EXPORT_PAGE_SIZE}`;

  const encoder = new TextEncoder();
  let cursor: [number, string] | null = null;
  let started = false;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!started) {
        started = true;
        controller.enqueue(encoder.encode(line(HEADER)));
        return;
      }
      try {
        const statement = cursor === null ? db.prepare(first).bind(...binds) : db.prepare(after).bind(...binds, ...cursor);
        const { results } = await statement.all<RequestRow>();
        if (results.length > 0) {
          controller.enqueue(encoder.encode(results.map(csvLine).join('')));
          const last = results[results.length - 1]!;
          cursor = [last.occurred_at, last.request_id];
        }
        if (results.length < EXPORT_PAGE_SIZE) controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
  return new Response(body, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'no-store',
    },
  });
}
