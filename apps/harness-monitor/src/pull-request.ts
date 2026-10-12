import type { CostQuery } from './costs';
import { requestFilter } from './export';
import { CATEGORIES, phaseSql, REVIEW_LEVELS, type Category } from './validate';

/** One category of the pull request's cost, and what it holds. */
export interface CategoryLine {
  category: Category;
  requests: number;
  costMicros: number;
  unpricedRequests: number;
  /** Local code review only: requests per review level, strongest last; a level the row never named is ''. */
  levels: { level: string; requests: number }[];
}

/** One agent of a session: its main agent, or one subagent it started. */
export interface AgentLine {
  kind: 'main' | 'subagent';
  /** The subagent's kind (Explore, general-purpose, ...); null on the main agent and where none was recorded. */
  type: string | null;
  id: string | null;
  models: string[];
  requests: number;
  tokens: number;
  costMicros: number;
  unpricedRequests: number;
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
  /** The main agent first (when it made a request), then its subagents, dearest first. */
  agents: AgentLine[];
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
      `SELECT ${phaseSql('u.')} AS category, COALESCE(u.review_level, '') AS level, COUNT(*) AS requests,
         SUM(COALESCE(u.cost_micros, 0)) AS costMicros, SUM(u.cost_micros IS NULL) AS unpriced
       ${from} ${where} GROUP BY ${phaseSql('u.')}, COALESCE(u.review_level, '')`,
    ).bind(...binds),
    db.prepare(
      `SELECT u.session_id AS sessionId, u.ran_where AS ranWhere, u.model AS model, u.subagent AS subagent,
         u.subagent_type AS subagentType, u.subagent_id AS subagentId, COUNT(*) AS requests,
         SUM(u.input_tokens + u.output_tokens + u.cache_creation_tokens + u.cache_read_tokens) AS tokens,
         SUM(COALESCE(u.cost_micros, 0)) AS costMicros, SUM(u.cost_micros IS NULL) AS unpriced
       ${from} ${where} GROUP BY u.session_id, u.ran_where, u.model, u.subagent, u.subagent_type, u.subagent_id`,
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
  const agents = new Map<string, AgentLine>();
  for (const r of bySession!.results as unknown as {
    sessionId: string;
    ranWhere: string;
    model: string;
    subagent: number;
    subagentType: string | null;
    subagentId: string | null;
    requests: number;
    tokens: number;
    costMicros: number;
    unpriced: number;
  }[]) {
    let s = sessions.get(r.sessionId);
    if (!s) {
      s = { sessionId: r.sessionId, where: [], models: [], requests: 0, tokens: 0, costMicros: 0, unpricedRequests: 0, agents: [] };
      sessions.set(r.sessionId, s);
    }
    if (!s.where.includes(r.ranWhere)) s.where.push(r.ranWhere);
    if (!s.models.includes(r.model)) s.models.push(r.model);
    s.requests += r.requests;
    s.tokens += r.tokens;
    s.costMicros += r.costMicros;
    s.unpricedRequests += r.unpriced;

    // Requests stored before the type was recorded all share one line, whatever subagent they were.
    const kind = r.subagent ? 'subagent' : 'main';
    const key = kind === 'main' ? `${r.sessionId}\0main` : `${r.sessionId}\0${r.subagentType ?? ''}\0${r.subagentId ?? ''}`;
    let a = agents.get(key);
    if (!a) {
      a = { kind, type: r.subagentType, id: r.subagentId, models: [], requests: 0, tokens: 0, costMicros: 0, unpricedRequests: 0 };
      agents.set(key, a);
      s.agents.push(a);
    }
    if (!a.models.includes(r.model)) a.models.push(r.model);
    a.requests += r.requests;
    a.tokens += r.tokens;
    a.costMicros += r.costMicros;
    a.unpricedRequests += r.unpriced;
  }
  const ordered = [...sessions.values()].sort((a, b) => b.costMicros - a.costMicros || a.sessionId.localeCompare(b.sessionId));
  for (const s of ordered) {
    s.where.sort();
    s.models.sort();
    for (const a of s.agents) a.models.sort();
    s.agents.sort(
      (a, b) =>
        Number(b.kind === 'main') - Number(a.kind === 'main') ||
        b.costMicros - a.costMicros ||
        (a.type ?? '').localeCompare(b.type ?? '') ||
        (a.id ?? '').localeCompare(b.id ?? ''),
    );
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
