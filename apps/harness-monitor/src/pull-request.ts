import type { CostQuery } from './costs';
import { requestFilter } from './export';
import { CATEGORIES, REVIEW_LEVELS, type Category } from './validate';

/** One category of the pull request's cost, and what it holds. */
export interface CategoryLine {
  category: Category;
  requests: number;
  costMicros: number;
  unpricedRequests: number;
  /** Local code review only: requests per review level, strongest last; a level the row never named is ''. */
  levels: { level: string; requests: number }[];
}

export interface SessionLine {
  sessionId: string;
  /** Where it ran: local, cloud or actions. */
  where: string[];
  models: string[];
  requests: number;
  tokens: number;
  costMicros: number;
  unpricedRequests: number;
}

export interface PullRequestPage {
  query: CostQuery;
  number: number;
  title: string;
  state: string;
  mergedAt: string | null;
  issue: number | null;
  engineer: string | null;
  branches: string[];
  /** Every category, in the page's order, zero where the filters keep none of it. */
  categories: CategoryLine[];
  sessions: SessionLine[];
  totalMicros: number;
  unpricedRequests: number;
}

interface LinkRow {
  branch: string;
  pr_number: number;
  title: string;
  state: string;
  merged_at: string | null;
  issue_number: number | null;
  engineer: string | null;
}

/**
 * One pull request's cost, from its request rows: the daily totals do not know
 * sessions. Only a pull request GitHub linking has seen is found; a number it
 * has not is null, shown as nothing found. The period and category filters
 * apply; an engineer filter does not, since a pull request has one author.
 */
export async function pullRequestPage(db: D1Database, query: CostQuery, number: number, now = Date.now()): Promise<PullRequestPage | null> {
  const { where, binds } = requestFilter({ ...query, engineer: null }, number, now);
  const from = 'FROM usage_requests u JOIN branch_links l ON l.branch = u.branch';
  const [links, byCategory, bySession] = await db.batch([
    db.prepare('SELECT * FROM branch_links WHERE pr_number = ? ORDER BY pr_updated_at DESC, branch').bind(number),
    db.prepare(
      `SELECT u.category AS category, COALESCE(u.review_level, '') AS level, COUNT(*) AS requests,
         SUM(COALESCE(u.cost_micros, 0)) AS costMicros, SUM(u.cost_micros IS NULL) AS unpriced
       ${from} ${where} GROUP BY u.category, COALESCE(u.review_level, '')`,
    ).bind(...binds),
    db.prepare(
      `SELECT u.session_id AS sessionId, u.ran_where AS ranWhere, u.model AS model, COUNT(*) AS requests,
         SUM(u.input_tokens + u.output_tokens + u.cache_creation_tokens + u.cache_read_tokens) AS tokens,
         SUM(COALESCE(u.cost_micros, 0)) AS costMicros, SUM(u.cost_micros IS NULL) AS unpriced
       ${from} ${where} GROUP BY u.session_id, u.ran_where, u.model`,
    ).bind(...binds),
  ]);
  const link = (links!.results as unknown as LinkRow[])[0];
  if (!link) return null;

  const categories = CATEGORIES.map((category): CategoryLine => ({ category, requests: 0, costMicros: 0, unpricedRequests: 0, levels: [] }));
  for (const r of byCategory!.results as unknown as { category: Category; level: string; requests: number; costMicros: number; unpriced: number }[]) {
    const line = categories.find((c) => c.category === r.category)!;
    line.requests += r.requests;
    line.costMicros += r.costMicros;
    line.unpricedRequests += r.unpriced;
    if (r.category === 'local-code-review') line.levels.push({ level: r.level, requests: r.requests });
  }
  const rank = (level: string) => (REVIEW_LEVELS as readonly string[]).indexOf(level);
  for (const c of categories) c.levels.sort((a, b) => rank(b.level) - rank(a.level));

  const sessions = new Map<string, SessionLine>();
  for (const r of bySession!.results as unknown as { sessionId: string; ranWhere: string; model: string; requests: number; tokens: number; costMicros: number; unpriced: number }[]) {
    let s = sessions.get(r.sessionId);
    if (!s) {
      s = { sessionId: r.sessionId, where: [], models: [], requests: 0, tokens: 0, costMicros: 0, unpricedRequests: 0 };
      sessions.set(r.sessionId, s);
    }
    if (!s.where.includes(r.ranWhere)) s.where.push(r.ranWhere);
    if (!s.models.includes(r.model)) s.models.push(r.model);
    s.requests += r.requests;
    s.tokens += r.tokens;
    s.costMicros += r.costMicros;
    s.unpricedRequests += r.unpriced;
  }
  const ordered = [...sessions.values()].sort((a, b) => b.costMicros - a.costMicros || a.sessionId.localeCompare(b.sessionId));
  for (const s of ordered) {
    s.where.sort();
    s.models.sort();
  }

  return {
    query,
    number,
    title: link.title,
    state: link.state,
    mergedAt: link.merged_at,
    issue: link.issue_number,
    engineer: link.engineer,
    branches: (links!.results as unknown as LinkRow[]).map((l) => l.branch),
    categories,
    sessions: ordered,
    totalMicros: categories.reduce((sum, c) => sum + c.costMicros, 0),
    unpricedRequests: categories.reduce((sum, c) => sum + c.unpricedRequests, 0),
  };
}
