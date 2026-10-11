import { CATEGORIES, type Category } from './validate';

/** What the costs page can be asked, parsed from the address; anything unrecognised is the default. */
export const PERIODS = { '7d': 7, '30d': 30, '90d': 90, all: null } as const;
export type Period = keyof typeof PERIODS;
export const GROUPS = ['pr', 'issue', 'engineer', 'category', 'day'] as const;
export type Group = (typeof GROUPS)[number];

/** The engineer filter's value for requests no pull request claims. */
export const UNATTRIBUTED = '~unattributed';

export const PAGE_SIZE = 25;

export interface CostQuery {
  period: Period;
  /** A GitHub login, UNATTRIBUTED, or null for everyone. */
  engineer: string | null;
  category: Category | null;
  group: Group;
  /** 1-based. */
  page: number;
}

export function parseQuery(params: URLSearchParams): CostQuery {
  const period = params.get('period') as Period;
  const group = params.get('group') as Group;
  const category = params.get('category') as Category;
  const page = Number(params.get('page'));
  return {
    // Own keys only: `in` would accept `toString` and the page would throw.
    period: period !== null && Object.hasOwn(PERIODS, period) ? period : '30d',
    engineer: params.get('engineer') || null,
    category: (CATEGORIES as readonly string[]).includes(category) ? category : null,
    group: (GROUPS as readonly string[]).includes(group) ? group : 'pr',
    page: Number.isInteger(page) && page >= 1 ? page : 1,
  };
}

/** The address of a query, canonical, so the edge cache keys one page one way. */
export function queryString(q: CostQuery, over: Partial<CostQuery> = {}): string {
  const all = { ...q, ...over };
  const params = new URLSearchParams();
  if (all.period !== '30d') params.set('period', all.period);
  if (all.engineer) params.set('engineer', all.engineer);
  if (all.category) params.set('category', all.category);
  if (all.group !== 'pr') params.set('group', all.group);
  if (all.page > 1) params.set('page', String(all.page));
  const text = params.toString();
  return text === '' ? '' : `?${text}`;
}

/** The first UTC day inside the period, or null for all time. */
export function firstDay(period: Period, now: number): string | null {
  const days = PERIODS[period];
  return days === null ? null : new Date(now - (days - 1) * 86_400_000).toISOString().slice(0, 10);
}

/** One category's dollars in one place, as the totals table holds them. */
export interface TotalRow {
  /** The UTC day, for a by-day query; '' otherwise. */
  day: string;
  /** '' for requests that ran on no branch. */
  branch: string;
  category: Category;
  costMicros: number;
  unpricedRequests: number;
  lastAt: number;
  prNumber: number | null;
  title: string | null;
  state: string | null;
  mergedAt: string | null;
  issue: number | null;
  engineer: string | null;
}

export interface CostGroup {
  key: string;
  label: string;
  /** A second line under the label. */
  sub: string | null;
  /** The pull request a by-pull-request group is, once linked; its page opens from the label. */
  prNumber: number | null;
  engineer: string | null;
  /** When a pull request merged, or its state while it has not. */
  merged: string | null;
  /** Distinct pull requests in the group. */
  pullRequests: number;
  byCategory: Record<Category, number>;
  totalMicros: number;
  unpricedRequests: number;
}

const NAMES: Record<Category, string> = {
  'scoping-planning': 'Scoping & planning',
  building: 'Building',
  'local-code-review': 'Local code review',
  'local-security-review': 'Local security review',
  'after-push': 'After push',
  'ci-reviews': 'CI reviews',
};
export const categoryName = (c: Category) => NAMES[c];

const none = (): Record<Category, number> => Object.fromEntries(CATEGORIES.map((c) => [c, 0])) as Record<Category, number>;

/** Where a row belongs for a grouping: its key, label and the second line, or what is known of its pull request. */
function placeOf(row: TotalRow, group: Group, linking: (row: TotalRow) => 'linking…' | 'unattributed') {
  const linked = row.prNumber !== null;
  switch (group) {
    case 'category':
      return { key: row.category, label: categoryName(row.category), sub: null };
    case 'day':
      return { key: row.day, label: row.day, sub: null };
    case 'engineer':
      return linked
        ? { key: row.engineer ?? '~unknown', label: row.engineer ?? 'unknown', sub: null }
        : { key: UNATTRIBUTED, label: 'Unattributed', sub: null };
    case 'issue':
      if (!linked) return { key: UNATTRIBUTED, label: 'Unattributed', sub: null };
      return row.issue === null
        ? { key: '~none', label: 'No issue', sub: null }
        : { key: `issue-${row.issue}`, label: `Issue #${row.issue}`, sub: null };
    case 'pr':
      return linked
        ? {
            key: `pr-${row.prNumber}`,
            label: `#${row.prNumber} ${row.title}`,
            sub: row.issue === null ? 'No issue' : `Issue #${row.issue}`,
          }
        : { key: `branch-${row.branch}`, label: row.branch === '' ? 'No branch' : row.branch, sub: row.branch === '' ? 'unattributed' : linking(row) };
  }
}

const mergedOf = (row: TotalRow) =>
  row.prNumber === null ? null : row.mergedAt !== null ? row.mergedAt.slice(0, 10) : (row.state ?? '').toLowerCase();

/**
 * Sums rows into groups, biggest total first. A session newer than the last
 * time linking caught up is "linking…" (its pull request may not have been
 * seen yet); otherwise a branch no pull request names is "unattributed".
 */
export function groupRows(rows: TotalRow[], group: Group, lastLinkSuccessAt: number | null): CostGroup[] {
  const linking = (row: TotalRow) => (row.branch !== '' && (lastLinkSuccessAt === null || row.lastAt > lastLinkSuccessAt) ? 'linking…' : 'unattributed');
  const groups = new Map<string, CostGroup>();
  const prs = new Map<string, Set<number>>();
  for (const row of rows) {
    const place = placeOf(row, group, linking);
    let g = groups.get(place.key);
    if (!g) {
      g = { ...place, prNumber: group === 'pr' ? row.prNumber : null, engineer: row.prNumber === null ? null : row.engineer, merged: mergedOf(row), pullRequests: 0, byCategory: none(), totalMicros: 0, unpricedRequests: 0 };
      groups.set(place.key, g);
      prs.set(place.key, new Set());
    }
    g.byCategory[row.category] += row.costMicros;
    g.totalMicros += row.costMicros;
    g.unpricedRequests += row.unpricedRequests;
    if (row.prNumber !== null) prs.get(place.key)!.add(row.prNumber);
  }
  for (const [key, g] of groups) g.pullRequests = prs.get(key)!.size;
  return [...groups.values()].sort((a, b) => b.totalMicros - a.totalMicros || a.label.localeCompare(b.label));
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

export interface CostsPage {
  query: CostQuery;
  engineers: string[];
  groups: CostGroup[];
  /** Per category, over every group (not only the shown page). */
  byCategory: Record<Category, number>;
  totalMicros: number;
  /** Epoch milliseconds; null while linking has never succeeded. */
  lastLinkSuccessAt: number | null;
}

/**
 * Reads the page's figures from the daily totals and the branch links, never
 * from the request rows: a public page view must not spend the free plan's
 * read allowance on the table that grows with every request.
 */
export async function costsPage(db: D1Database, query: CostQuery, now = Date.now()): Promise<CostsPage> {
  const first = firstDay(query.period, now);
  const where: string[] = [];
  const binds: (string | number)[] = [];
  if (first !== null) {
    where.push('t.day >= ?');
    binds.push(first);
  }
  if (query.category !== null) {
    where.push('t.category = ?');
    binds.push(query.category);
  }
  if (query.engineer === UNATTRIBUTED) where.push('l.branch IS NULL');
  else if (query.engineer !== null) {
    where.push('l.engineer = ?');
    binds.push(query.engineer);
  }
  const needsLinks = query.group !== 'day' || query.engineer !== null;
  const conditions = where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`;
  // A by-day question needs no branch unless it filters by engineer, which is the one thing a link says.
  const select =
    query.group === 'day'
      ? `SELECT t.day AS day, '' AS branch, t.category AS category, SUM(t.cost_micros) AS costMicros,
           SUM(t.unpriced_requests) AS unpricedRequests, MAX(t.last_at) AS lastAt,
           NULL AS prNumber, NULL AS title, NULL AS state, NULL AS mergedAt, NULL AS issue, NULL AS engineer
         FROM daily_branch_totals t ${needsLinks ? 'LEFT JOIN branch_links l ON l.branch = t.branch' : ''}
         ${conditions} GROUP BY t.day, t.category`
      : `SELECT '' AS day, t.branch AS branch, t.category AS category, SUM(t.cost_micros) AS costMicros,
           SUM(t.unpriced_requests) AS unpricedRequests, MAX(t.last_at) AS lastAt,
           l.pr_number AS prNumber, l.title AS title, l.state AS state, l.merged_at AS mergedAt,
           l.issue_number AS issue, l.engineer AS engineer
         FROM daily_branch_totals t LEFT JOIN branch_links l ON l.branch = t.branch
         ${conditions} GROUP BY t.branch, t.category`;

  const [rows, engineers, state] = await db.batch([
    db.prepare(select).bind(...binds),
    db.prepare('SELECT DISTINCT engineer FROM branch_links WHERE engineer IS NOT NULL ORDER BY engineer'),
    db.prepare('SELECT last_success_at AS lastSuccessAt FROM link_state WHERE id = 1'),
  ]);
  const lastLinkSuccessAt = (state!.results[0] as { lastSuccessAt: number | null } | undefined)?.lastSuccessAt ?? null;
  const groups = groupRows(rows!.results as unknown as TotalRow[], query.group, lastLinkSuccessAt);
  const byCategory = none();
  for (const g of groups) for (const c of CATEGORIES) byCategory[c] += g.byCategory[c];
  return {
    query,
    engineers: (engineers!.results as { engineer: string }[]).map((e) => e.engineer),
    groups,
    byCategory,
    totalMicros: groups.reduce((sum, g) => sum + g.totalMicros, 0),
    lastLinkSuccessAt,
  };
}
