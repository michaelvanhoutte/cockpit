import { startOfDay } from './belgium';
import { firstDay, UNATTRIBUTED, type CostQuery } from './costs';
import { requestPhaseSql } from './validate';

/**
 * Rows read per D1 query. The free plan allows 50 queries per invocation, so a
 * year's 600,000 requests need 30 of them at this size; each page is a few
 * megabytes, which a Worker holds without strain.
 */
export const EXPORT_PAGE_SIZE = 20_000;

/**
 * The request rows a question keeps: the same day, category and engineer rules the page's totals apply, and one pull request if asked.
 * The period starts at a Belgian midnight and is cut on the request's exact time, never on the day stored on its row, which for older rows is a UTC day.
 * The engineer is the author of the request's own pull request, else of the one it is credited to (`e`, joined by `exportCsv` for every question but one pull request's).
 */
export function requestFilter(query: CostQuery, pullRequest: number | null, now = Date.now()): { where: string; binds: (string | number)[] } {
  const where: string[] = [];
  const binds: (string | number)[] = [];
  const first = firstDay(query.period, now);
  if (first !== null) {
    where.push('u.occurred_at >= ?');
    binds.push(startOfDay(first));
  }
  if (query.category !== null) {
    where.push(`${requestPhaseSql('u.')} = ?`);
    binds.push(query.category);
  }
  if (query.model !== null) {
    where.push('u.model = ?');
    binds.push(query.model);
  }
  if (query.who !== 'all') where.push(`u.subagent = ${query.who === 'subagents' ? 1 : 0}`);
  const credited = pullRequest === null;
  if (query.engineer === UNATTRIBUTED) where.push(credited ? 'COALESCE(l.branch, e.branch) IS NULL' : 'l.branch IS NULL');
  else if (query.engineer !== null) {
    where.push(credited ? 'COALESCE(l.engineer, e.engineer) = ?' : 'l.engineer = ?');
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

export const line = (cells: (string | number | null)[]) => `${cells.map(cell).join(',')}\r\n`;

/**
 * A CSV as a stream: the header, then one page of lines each time the response
 * is consumed, so a year of rows is never held at once and the response starts
 * at once. `read` takes the cursor after the last line sent (null for the first
 * page) and answers the page's lines, how many rows it held, and the cursor after
 * them; a page short of `pageSize` is the last.
 */
export function csvStream<C>(
  header: string[],
  pageSize: number,
  read: (cursor: C | null) => Promise<{ text: string; count: number; cursor: C | null }>,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let cursor: C | null = null;
  let started = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!started) {
        started = true;
        controller.enqueue(encoder.encode(line(header)));
        return;
      }
      try {
        const page = await read(cursor);
        if (page.count > 0) controller.enqueue(encoder.encode(page.text));
        cursor = page.cursor;
        if (page.count < pageSize) controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
}

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
  // A request credited to a pull request its own branch does not have carries that pull request's issue and engineer, and no pull request.
  const base =
    pullRequest === null
      ? `SELECT u.occurred_at, u.request_id, u.session_id, u.branch, l.pr_number AS prNumber, COALESCE(l.issue_number, e.issue_number) AS issue,
      COALESCE(l.engineer, e.engineer) AS engineer, ${requestPhaseSql('u.')} AS category, u.model, u.speed, u.ran_where, u.input_tokens, u.output_tokens,
      u.cache_creation_tokens, u.cache_read_tokens, u.cost_micros, u.price_basis
    FROM usage_requests u LEFT JOIN branch_links l ON l.branch = u.branch
    LEFT JOIN request_credits c ON l.branch IS NULL AND c.request_id = u.request_id
    LEFT JOIN branch_links e ON e.branch = c.credit_branch`
      : // One pull request starts from its few branches and reads their rows through usage_requests_branch;
        // left to itself the planner walks every request in time order to honour the ORDER BY.
        `SELECT u.occurred_at, u.request_id, u.session_id, u.branch, l.pr_number AS prNumber, l.issue_number AS issue,
      l.engineer AS engineer, ${requestPhaseSql('u.')} AS category, u.model, u.speed, u.ran_where, u.input_tokens, u.output_tokens,
      u.cache_creation_tokens, u.cache_read_tokens, u.cost_micros, u.price_basis
    FROM branch_links l CROSS JOIN usage_requests u ON l.branch = u.branch`;
  const first = `${base} ${where} ORDER BY u.occurred_at, u.request_id LIMIT ${EXPORT_PAGE_SIZE}`;
  const after = `${base} ${where === '' ? 'WHERE' : `${where} AND`} (u.occurred_at, u.request_id) > (?, ?)
    ORDER BY u.occurred_at, u.request_id LIMIT ${EXPORT_PAGE_SIZE}`;

  const body = csvStream<[number, string]>(HEADER, EXPORT_PAGE_SIZE, async (cursor) => {
    const statement = cursor === null ? db.prepare(first).bind(...binds) : db.prepare(after).bind(...binds, ...cursor);
    const { results } = await statement.all<RequestRow>();
    const last = results[results.length - 1];
    return { text: results.map(csvLine).join(''), count: results.length, cursor: last ? [last.occurred_at, last.request_id] : cursor };
  });
  return new Response(body, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'no-store',
    },
  });
}
