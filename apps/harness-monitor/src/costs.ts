import { jobReads, jobStatuses, type JobStatus } from './jobs';
import { CATEGORIES, PHASES_BEGIN, phaseSql, WHERE, type Category } from './validate';

/** The phase a totals row counts as: the stored one, except Building before phase marks existed. */
const PHASE = phaseSql('t.');

/** What the costs page can be asked, parsed from the address; anything unrecognised is the default. */
export const PERIODS = { '7d': 7, '30d': 30, '90d': 90, all: null } as const;
export type Period = keyof typeof PERIODS;
/** Over time ('day') comes first and is the page the bare address opens. */
export const GROUPS = ['day', 'pr', 'issue', 'engineer', 'category'] as const;
export type Group = (typeof GROUPS)[number];
export const DEFAULT_GROUP: Group = 'day';

/** How the table is ordered: the grouping's own natural order, or dearest first. Engineers are always by total. */
export const SORTS = ['default', 'total'] as const;
export type Sort = (typeof SORTS)[number];

/** What the dollars are split by: the "where it went" bar, each row's split bar and the $ columns. */
export const SPLITS = ['phase', 'model', 'where', 'outcome'] as const;
export type Split = (typeof SPLITS)[number];
/** Which requests count: all of them, a session's own agent, or the subagents it started. */
export const WHOS = ['all', 'main', 'subagents'] as const;
export type Who = (typeof WHOS)[number];
/** A model id as the usage hook sends it: letters, digits and a few separators, never free text. */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:\[\]-]{0,99}$/;

/** The engineer filter's value for requests no pull request claims. */
export const UNATTRIBUTED = '~unattributed';

export const PAGE_SIZE = 25;

export interface CostQuery {
  period: Period;
  /** A GitHub login, UNATTRIBUTED, or null for everyone. */
  engineer: string | null;
  category: Category | null;
  /** A model id, or null for every model. */
  model: string | null;
  who: Who;
  group: Group;
  split: Split;
  /** 'default' for an engineer grouping, whose order cannot be switched. */
  sort: Sort;
  /** 1-based. */
  page: number;
}

export function parseQuery(params: URLSearchParams): CostQuery {
  const period = params.get('period') as Period;
  const group = params.get('group') as Group;
  const category = params.get('category') as Category;
  const split = params.get('split') as Split;
  const who = params.get('who') as Who;
  const model = params.get('model') ?? '';
  const page = Number(params.get('page'));
  const group_ = (GROUPS as readonly string[]).includes(group) ? group : DEFAULT_GROUP;
  return {
    // Own keys only: `in` would accept `toString` and the page would throw.
    period: period !== null && Object.hasOwn(PERIODS, period) ? period : '30d',
    engineer: params.get('engineer') || null,
    category: (CATEGORIES as readonly string[]).includes(category) ? category : null,
    model: MODEL_ID.test(model) ? model : null,
    who: (WHOS as readonly string[]).includes(who) ? who : 'all',
    group: group_,
    split: (SPLITS as readonly string[]).includes(split) ? split : 'phase',
    sort: params.get('sort') === 'total' && group_ !== 'engineer' ? 'total' : 'default',
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
  if (all.model) params.set('model', all.model);
  if (all.who !== 'all') params.set('who', all.who);
  if (all.group !== DEFAULT_GROUP) params.set('group', all.group);
  if (all.split !== 'phase') params.set('split', all.split);
  // An engineer grouping is always by total, so it never carries a sort; a new grouping starts in its own order.
  if (all.sort === 'total' && all.group !== 'engineer') params.set('sort', 'total');
  if (all.page > 1) params.set('page', String(all.page));
  const text = params.toString();
  return text === '' ? '' : `?${text}`;
}

/** The first UTC day inside the period, or null for all time. */
export function firstDay(period: Period, now: number): string | null {
  const days = PERIODS[period];
  return days === null ? null : new Date(now - (days - 1) * 86_400_000).toISOString().slice(0, 10);
}

/** One series' dollars in one place, as the totals table holds them. */
export interface TotalRow {
  /** The UTC day, for a by-day query; '' otherwise. */
  day: string;
  /** '' for requests that ran on no branch. */
  branch: string;
  /** The row's phase when the page groups by category; '' otherwise. */
  category: string;
  /** Which series of the split this is: a phase, model, place or outcome key. */
  series: string;
  costMicros: number;
  unpricedRequests: number;
  lastAt: number;
  prNumber: number | null;
  title: string | null;
  state: string | null;
  mergedAt: string | null;
  issue: number | null;
  engineer: string | null;
  /** What linking read of the pull request; null until it has, or has read every file. */
  linesAdded: number | null;
  linesRemoved: number | null;
  openedAt: string | null;
  ciRounds: number | null;
  /** Local review rounds and their findings, from the session record in the pull request body. */
  localRounds: number | null;
  findings: number | null;
  /** The closing issue's title. */
  issueTitle: string | null;
}

export interface CostGroup {
  key: string;
  label: string;
  /** A second line under the label. */
  sub: string | null;
  /** A catch-all gathers costs nothing names (Unattributed, No issue, unknown, No branch): it keeps its row and numbers but draws no split bar. */
  catchAll: boolean;
  /** The pull request a by-pull-request group is, once linked. */
  prNumber: number | null;
  /** The issue a by-pull-request or by-issue group names; null for none. */
  issue: number | null;
  engineer: string | null;
  /** When a pull request merged, or its state while it has not. */
  merged: string | null;
  /** How long a merged pull request was open, as a short phrase; null while it is not merged or its opening is unknown. */
  openToMerged: string | null;
  /** Lines added and removed, leaving out lockfiles, snapshots and generated files; null until sized. */
  lines: { added: number; removed: number } | null;
  /** Head commits pushed after it opened; null until read. */
  ciRounds: number | null;
  /** Local review rounds plus CI rounds; null while either is unknown. */
  rounds: number | null;
  /** Findings the local reviews reported; null unless every review carried a count. */
  findings: number | null;
  /** Distinct pull requests in the group. */
  pullRequests: number;
  /** Dollars per series key of the split; a key the group has none of is absent. */
  bySeries: Record<string, number>;
  totalMicros: number;
  unpricedRequests: number;
}

/** A model id is free text, so series dollars live in an object with no prototype: no id can be `__proto__`. */
const bag = (): Record<string, number> => Object.create(null) as Record<string, number>;

/** One column of the split: its key, name, and the short name over a column. */
export interface Series {
  key: string;
  label: string;
  short: string;
}

const WHERE_NAMES: Record<(typeof WHERE)[number], [label: string, short: string]> = {
  local: ["Engineers' machines", "Engineers' machines"],
  cloud: ['Cloud sessions', 'Cloud'],
  actions: ['CI (GitHub Actions)', 'CI'],
};
const WHERE_SERIES: Series[] = WHERE.map((key) => ({ key, label: WHERE_NAMES[key][0], short: WHERE_NAMES[key][1] }));
const OUTCOME_SERIES: Series[] = [
  { key: 'merged', label: 'Merged', short: 'Merged' },
  { key: 'open', label: 'Still open', short: 'Open' },
  { key: 'closed', label: 'Closed unmerged', short: 'Closed' },
  { key: 'no-pr', label: 'No pull request', short: 'No PR' },
  { key: 'on-main', label: 'On main', short: 'On main' },
];

const NAMES: Record<Category, string> = {
  unphased: 'Unphased',
  'scoping-planning': 'Scoping & planning',
  building: 'Building',
  'local-code-review': 'Local code review',
  'local-security-review': 'Local security review',
  'after-push': 'After push',
  'ci-reviews': 'CI reviews',
};
export const categoryName = (c: Category) => NAMES[c];
const PHASE_SHORT: Record<Category, string> = {
  unphased: 'Unphased',
  'scoping-planning': 'Scoping',
  building: 'Building',
  'local-code-review': 'Code rev.',
  'local-security-review': 'Security rev.',
  'after-push': 'After push',
  'ci-reviews': 'CI rev.',
};

/**
 * The columns of a split, in order. Phases, places and outcomes are fixed;
 * models are the ones with dollars in the result, biggest first.
 */
export function seriesOf(split: Split, totals: Record<string, number>): Series[] {
  switch (split) {
    case 'phase':
      return CATEGORIES.map((c) => ({ key: c, label: categoryName(c), short: PHASE_SHORT[c] }));
    case 'where':
      return WHERE_SERIES;
    case 'outcome':
      return OUTCOME_SERIES;
    case 'model':
      return Object.keys(totals)
        .filter((m) => totals[m]! > 0)
        .sort((a, b) => totals[b]! - totals[a]! || a.localeCompare(b))
        .map((m) => ({ key: m, label: m, short: m }));
  }
}

/** Where a row belongs for a grouping: its key, label and the second line, or what is known of its pull request. */
function placeOf(row: TotalRow, group: Group, linking: (row: TotalRow) => 'linking…' | 'unattributed') {
  const linked = row.prNumber !== null;
  switch (group) {
    case 'category':
      return { key: row.category, label: categoryName(row.category as Category), sub: null, catchAll: false };
    case 'day':
      return { key: row.day, label: row.day, sub: null, catchAll: false };
    case 'engineer':
      return linked
        ? { key: row.engineer ?? '~unknown', label: row.engineer ?? 'unknown', sub: null, catchAll: row.engineer === null }
        : { key: UNATTRIBUTED, label: 'Unattributed', sub: null, catchAll: true };
    case 'issue':
      if (!linked) return { key: UNATTRIBUTED, label: 'Unattributed', sub: null, catchAll: true };
      return row.issue === null
        ? { key: '~none', label: 'No issue', sub: null, catchAll: true }
        : { key: `issue-${row.issue}`, label: issueLabel(row.issue, row.issueTitle), sub: null, catchAll: false };
    case 'pr':
      // A single named branch no pull request names is one branch, not a catch-all, so it keeps its bar.
      return linked
        ? {
            key: `pr-${row.prNumber}`,
            label: `#${row.prNumber} ${row.title}`,
            sub: row.issue === null ? 'No issue' : `Issue #${row.issue}`,
            catchAll: false,
          }
        : { key: `branch-${row.branch}`, label: row.branch === '' ? 'No branch' : row.branch, sub: row.branch === '' ? 'unattributed' : linking(row), catchAll: row.branch === '' };
  }
}

/** An issue as a row names it: "#N title", or "#N" until its title has been read. */
const issueLabel = (number: number, title: string | null) => (title ? `#${number} ${title}` : `#${number}`);

/** How long a pull request was open, in its two largest units: "45m", "5h 10m", "2d 4h". */
export function openFor(openedAt: string, closedAt: string): string {
  const minutes = Math.max(0, Math.floor((Date.parse(closedAt) - Date.parse(openedAt)) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return `${Math.floor(minutes / (24 * 60))}d ${Math.floor((minutes % (24 * 60)) / 60)}h`;
}

const mergedOf = (row: TotalRow) =>
  row.prNumber === null ? null : row.mergedAt !== null ? row.mergedAt.slice(0, 10) : (row.state ?? '').toLowerCase();

const ms = (iso: string | null) => (iso === null ? 0 : Date.parse(iso) || 0);

/** Where a row's pull request stands in the default order: open first, then merged or closed, then a branch no pull request names. */
interface Recency {
  tier: 0 | 1 | 2;
  /** Opened for an open pull request, merged (or opened, if closed unmerged) for the rest, last activity for a branch. */
  at: number;
}
function recencyOf(row: TotalRow): Recency {
  if (row.prNumber === null) return { tier: 2, at: row.lastAt };
  if (row.state === 'OPEN') return { tier: 0, at: ms(row.openedAt) };
  return { tier: 1, at: ms(row.mergedAt ?? row.openedAt) };
}
const newer = (a: Recency, b: Recency) => a.tier - b.tier || b.at - a.at;

/**
 * Sums rows into groups. The default order is each grouping's own: pull
 * requests newest first (open ones, then merged by merge date, then branches
 * no pull request names), issues by their newest pull request, categories in
 * pipeline order, days newest first, with catch-alls last. `total` is dearest
 * first, and engineers are always by total. A session newer than the last
 * time linking caught up is "linking…" (its pull request may not have been
 * seen yet); otherwise a branch no pull request names is "unattributed".
 */
export function groupRows(rows: TotalRow[], group: Group, lastLinkSuccessAt: number | null, sort: Sort = 'default'): CostGroup[] {
  const linking = (row: TotalRow) => (row.branch !== '' && (lastLinkSuccessAt === null || row.lastAt > lastLinkSuccessAt) ? 'linking…' : 'unattributed');
  const groups = new Map<string, CostGroup>();
  const prs = new Map<string, Set<number>>();
  const recency = new Map<string, Recency>();
  for (const row of rows) {
    const place = placeOf(row, group, linking);
    let g = groups.get(place.key);
    if (!g) {
      g = { ...place, prNumber: group === 'pr' ? row.prNumber : null, issue: group === 'pr' || group === 'issue' ? row.issue : null, engineer: row.prNumber === null ? null : row.engineer, merged: mergedOf(row), pullRequests: 0, openToMerged: row.openedAt !== null && row.mergedAt !== null ? openFor(row.openedAt, row.mergedAt) : null, lines: row.linesAdded !== null && row.linesRemoved !== null ? { added: row.linesAdded, removed: row.linesRemoved } : null, ciRounds: row.ciRounds, rounds: row.localRounds !== null && row.ciRounds !== null ? row.localRounds + row.ciRounds : null, findings: row.findings, bySeries: bag(), totalMicros: 0, unpricedRequests: 0 };
      groups.set(place.key, g);
      prs.set(place.key, new Set());
    }
    g.bySeries[row.series] = (g.bySeries[row.series] ?? 0) + row.costMicros;
    g.totalMicros += row.costMicros;
    g.unpricedRequests += row.unpricedRequests;
    // Two pull requests on one issue may have been read apart, one before the title was.
    if (group === 'issue' && row.issue !== null && row.issueTitle && g.label === issueLabel(row.issue, null)) g.label = issueLabel(row.issue, row.issueTitle);
    if (row.prNumber !== null) prs.get(place.key)!.add(row.prNumber);
    const r = recencyOf(row);
    const best = recency.get(place.key);
    if (!best || newer(r, best) < 0) recency.set(place.key, r);
  }
  for (const [key, g] of groups) g.pullRequests = prs.get(key)!.size;
  const byTotal = (a: CostGroup, b: CostGroup) => b.totalMicros - a.totalMicros || a.label.localeCompare(b.label);
  const list = [...groups.values()];
  if (group === 'engineer' || sort === 'total') return list.sort(group === 'day' ? (a, b) => b.totalMicros - a.totalMicros || b.key.localeCompare(a.key) : byTotal);
  const order = (a: CostGroup, b: CostGroup) => {
    switch (group) {
      case 'day':
        return b.key.localeCompare(a.key);
      case 'category':
        return CATEGORIES.indexOf(a.key as Category) - CATEGORIES.indexOf(b.key as Category);
      default:
        return newer(recency.get(a.key)!, recency.get(b.key)!) || a.label.localeCompare(b.label);
    }
  };
  return list.sort((a, b) => Number(a.catchAll) - Number(b.catchAll) || (a.catchAll ? a.key.localeCompare(b.key) : order(a, b)));
}

/** One line of the per-day chart: a series' dollars on every day of the range. */
export interface DayLine {
  key: string;
  label: string;
  /** One value per day, in micros; 0 for a day with no cost. */
  micros: number[];
}

export interface DayChart {
  /** Every UTC day from the first to the last, oldest first. */
  days: string[];
  /** A line per series with any cost. */
  lines: DayLine[];
  /** The total's dollars on each day. */
  total: number[];
}

const DAY_MS = 86_400_000;

/**
 * Cost per day as lines: one per series of the split that has cost, and the
 * total. The range runs from the period's first day (the earliest day with
 * cost for all time) to today, so a day with no cost is a zero, not a gap.
 */
export function dayChart(groups: CostGroup[], series: Series[], first: string | null, now: number): DayChart {
  if (groups.length === 0) return { days: [], lines: [], total: [] };
  const byDay = new Map(groups.map((g) => [g.key, g]));
  const keys = groups.map((g) => g.key).sort();
  const start = first ?? keys[0]!;
  const today = new Date(now).toISOString().slice(0, 10);
  const end = today > keys.at(-1)! ? today : keys.at(-1)!;
  const days: string[] = [];
  for (let t = Date.parse(start); t <= Date.parse(end); t += DAY_MS) days.push(new Date(t).toISOString().slice(0, 10));
  const lines = series
    .filter((s) => groups.some((g) => (g.bySeries[s.key] ?? 0) > 0))
    .map((s) => ({ key: s.key, label: s.label, micros: days.map((d) => byDay.get(d)?.bySeries[s.key] ?? 0) }));
  return { days, lines, total: days.map((d) => byDay.get(d)?.totalMicros ?? 0) };
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

/** A session's first main-agent request: the day it was made and what it started with. */
export interface SessionStart {
  day: string;
  /** Input, cache write and cache read tokens of the request. */
  tokens: number;
}

/** A merged pull request: the day it merged, the lines it changed once sized, and its cost per phase. */
export interface MergedPullRequest {
  day: string;
  /** Lines added plus removed, leaving out lockfiles, snapshots and generated files; null until sized. */
  lines: number | null;
  costByPhase: Record<string, number>;
}

/** One line of a trend chart: a value per bucket, null where the bucket has none to show. */
export interface TrendLine {
  key: string;
  label: string;
  values: (number | null)[];
}

export interface Trends {
  /** The first UTC day of each bucket, oldest first: a day, or the Monday of a week. */
  buckets: string[];
  weekly: boolean;
  /** Median tokens in a session's first main-agent request. */
  startingContext: (number | null)[];
  /** Median lines changed per merged pull request. */
  prSize: (number | null)[];
  /** Micros per 1,000 lines changed: the total first, then each phase that is drawn anywhere. */
  costPerThousandLines: TrendLine[];
}

/** The Monday of the week a UTC day falls in. */
export function weekStart(day: string): string {
  const t = Date.parse(day);
  return new Date(t - ((new Date(t).getUTCDay() + 6) % 7) * DAY_MS).toISOString().slice(0, 10);
}

/**
 * The charts' values per bucket: days for 7 and 30 days, weeks (starting
 * Monday) otherwise. A bucket with nothing to show holds null, not zero.
 * Cost per line divides the merged pull requests' cost by their thousands of
 * lines, leaving out a pull request with no counted lines from both. A phase
 * is not drawn before it was recorded: Unphased only before the day phase marks
 * began, every other phase only from then on.
 */
export function trends(sessions: SessionStart[], pullRequests: MergedPullRequest[], period: Period, now: number): Trends {
  const weekly = period !== '7d' && period !== '30d';
  const bucketOf = (day: string) => (weekly ? weekStart(day) : day);
  const span = weekly ? 7 : 1;
  const today = new Date(now).toISOString().slice(0, 10);
  const earliest = [...sessions.map((s) => s.day), ...pullRequests.map((p) => p.day)].sort()[0];
  const first = firstDay(period, now) ?? earliest;
  const buckets: string[] = [];
  if (first !== undefined) for (let t = Date.parse(bucketOf(first)); t <= Date.parse(today); t += span * DAY_MS) buckets.push(new Date(t).toISOString().slice(0, 10));

  const index = new Map(buckets.map((b, i) => [b, i]));
  const tokens: number[][] = buckets.map(() => []);
  for (const s of sessions) tokens[index.get(bucketOf(s.day)) ?? -1]?.push(s.tokens);
  const merged: MergedPullRequest[][] = buckets.map(() => []);
  for (const p of pullRequests) merged[index.get(bucketOf(p.day)) ?? -1]?.push(p);

  const sizes = merged.map((prs) => prs.flatMap((p) => (p.lines === null ? [] : [p.lines])));
  const counted = merged.map((prs) => prs.filter((p) => p.lines !== null && p.lines > 0));
  const perThousand = (prs: MergedPullRequest[], phase: string | null) => {
    const lines = prs.reduce((sum, p) => sum + p.lines!, 0);
    const cost = prs.reduce((sum, p) => sum + (phase === null ? Object.values(p.costByPhase).reduce((a, b) => a + b, 0) : (p.costByPhase[phase] ?? 0)), 0);
    return (cost / lines) * 1000;
  };
  const drawn = (phase: string, bucket: string) => {
    const last = new Date(Date.parse(bucket) + (span - 1) * DAY_MS).toISOString().slice(0, 10);
    return phase === 'unphased' ? bucket < PHASES_BEGIN : last >= PHASES_BEGIN;
  };
  const phaseLines = CATEGORIES.map((c) => ({
    key: c as string,
    label: categoryName(c),
    values: buckets.map((b, i) => (counted[i]!.length === 0 || !drawn(c, b) ? null : perThousand(counted[i]!, c))),
  })).filter((l) => l.values.some((v) => v !== null && v > 0));
  return {
    buckets,
    weekly,
    startingContext: tokens.map((t) => (t.length === 0 ? null : median(t))),
    prSize: sizes.map((s) => (s.length === 0 ? null : median(s))),
    costPerThousandLines: [{ key: 'total', label: 'All phases', values: counted.map((prs) => (prs.length === 0 ? null : perThousand(prs, null))) }, ...phaseLines],
  };
}

/** Everything the comparison says about one window of the period. */
export interface WindowFigures {
  micros: number;
  /** Dollars per series key, for each way of splitting. */
  byDimension: Record<Split, Record<string, number>>;
  /** Pull requests merged in the window that have a cost under the filters. */
  mergedPullRequests: number;
  /** Null when nothing merged, rather than zero or infinity. */
  costPerPullRequest: number | null;
  /** Median lines changed over the merged pull requests that are sized, as the size chart takes it. */
  linesPerPullRequest: number | null;
  /** Micros per 1,000 lines, over the merged pull requests with counted lines. */
  costPerThousandLines: number | null;
  /** Median tokens in a session's first main-agent request. */
  startingContext: number | null;
}

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
const costOf = (p: MergedPullRequest) => sum(Object.values(p.costByPhase));

export function windowFigures(byDimension: Record<Split, Record<string, number>>, sessions: SessionStart[], pullRequests: MergedPullRequest[]): WindowFigures {
  const sized = pullRequests.filter((p) => p.lines !== null);
  const counted = pullRequests.filter((p) => p.lines !== null && p.lines > 0);
  const lines = sum(counted.map((p) => p.lines!));
  return {
    micros: sum(Object.values(byDimension.phase)),
    byDimension,
    mergedPullRequests: pullRequests.length,
    costPerPullRequest: pullRequests.length === 0 ? null : sum(pullRequests.map(costOf)) / pullRequests.length,
    linesPerPullRequest: sized.length === 0 ? null : median(sized.map((p) => p.lines!)),
    costPerThousandLines: lines === 0 ? null : (sum(counted.map(costOf)) / lines) * 1000,
    startingContext: sessions.length === 0 ? null : median(sessions.map((s) => s.tokens)),
  };
}

/** A change smaller than this is noise and is left out of a dimension's list: 50 cents, in micros. */
export const SMALLEST_CHANGE_MICROS = 500_000;
/** How many changes a dimension lists. */
export const CHANGES_SHOWN = 4;

export interface Driver {
  key: 'merged' | 'cost-per-pr' | 'lines-per-pr' | 'cost-per-line' | 'starting-context';
  label: string;
  /** How the page writes the values. */
  unit: 'count' | 'dollars' | 'lines' | 'tokens';
  current: number | null;
  previous: number | null;
}

export interface Change {
  key: string;
  label: string;
  currentMicros: number;
  previousMicros: number;
  /** Positive for an increase. */
  changeMicros: number;
}

export interface Comparison {
  current: { from: string; to: string };
  previous: { from: string; to: string };
  currentMicros: number;
  previousMicros: number;
  changeMicros: number;
  /** Null when the previous window has no cost to be a percent of. */
  changePercent: number | null;
  drivers: Driver[];
  /** The largest changes in each way of splitting, by size in dollars; empty for "no change". */
  dimensions: { split: Split; changes: Change[] }[];
}

/** The largest changes between two windows' series, by size; a series in only one window counts as all of its dollars. */
export function topChanges(split: Split, current: Record<string, number>, previous: Record<string, number>): Change[] {
  const both = bag();
  for (const [k, v] of [...Object.entries(current), ...Object.entries(previous)]) both[k] = (both[k] ?? 0) + v;
  const labels = new Map(seriesOf(split, both).map((s) => [s.key, s.label]));
  return Object.keys(both)
    .map((key) => ({ key, label: labels.get(key) ?? key, currentMicros: current[key] ?? 0, previousMicros: previous[key] ?? 0, changeMicros: (current[key] ?? 0) - (previous[key] ?? 0) }))
    .filter((c) => Math.abs(c.changeMicros) >= SMALLEST_CHANGE_MICROS)
    .sort((a, b) => Math.abs(b.changeMicros) - Math.abs(a.changeMicros) || a.label.localeCompare(b.label))
    .slice(0, CHANGES_SHOWN);
}

export function compare(current: WindowFigures, previous: WindowFigures, windows: Pick<Comparison, 'current' | 'previous'>): Comparison {
  const driver = (key: Driver['key'], label: string, unit: Driver['unit'], pick: (w: WindowFigures) => number | null): Driver => ({ key, label, unit, current: pick(current), previous: pick(previous) });
  return {
    ...windows,
    currentMicros: current.micros,
    previousMicros: previous.micros,
    changeMicros: current.micros - previous.micros,
    changePercent: previous.micros === 0 ? null : ((current.micros - previous.micros) / previous.micros) * 100,
    drivers: [
      driver('merged', 'Merged pull requests', 'count', (w) => w.mergedPullRequests),
      driver('cost-per-pr', 'Cost per merged pull request', 'dollars', (w) => w.costPerPullRequest),
      driver('lines-per-pr', 'Median lines per merged pull request', 'lines', (w) => w.linesPerPullRequest),
      driver('cost-per-line', 'Cost per 1,000 lines', 'dollars', (w) => w.costPerThousandLines),
      driver('starting-context', 'Median starting context', 'tokens', (w) => w.startingContext),
    ],
    dimensions: SPLITS.map((split) => ({ split, changes: topChanges(split, current.byDimension[split], previous.byDimension[split]) })),
  };
}

/** The period's window and the one before it, of the same length; null for all time, which has no before. */
export function windowsOf(period: Period, now: number): Pick<Comparison, 'current' | 'previous'> | null {
  const days = PERIODS[period];
  if (days === null) return null;
  const day = (t: number) => new Date(t).toISOString().slice(0, 10);
  const from = now - (days - 1) * DAY_MS;
  return { current: { from: day(from), to: day(now) }, previous: { from: day(from - days * DAY_MS), to: day(from - DAY_MS) } };
}

export interface CostsPage {
  query: CostQuery;
  engineers: string[];
  /** Every model with dollars on record, for the Model filter. */
  models: string[];
  groups: CostGroup[];
  /** The split's columns, in order. */
  series: Series[];
  /** Per series key, over every group (not only the shown page). */
  bySeries: Record<string, number>;
  totalMicros: number;
  /** Epoch milliseconds; null while linking has never succeeded. */
  lastLinkSuccessAt: number | null;
  /** What each job last did: read in the same batch as the figures. */
  jobs: JobStatus[];
  /** The Over time page's trend charts; null for every other grouping. */
  trends: Trends | null;
  /** This period against the one before it, under the same filters; null for all time. */
  comparison: Comparison | null;
}

/** Where a request's pull request stands, from its branch and the link GitHub linking stored. */
const OUTCOME = `CASE WHEN t.branch = 'main' THEN 'on-main' WHEN l.state = 'MERGED' THEN 'merged' WHEN l.state = 'OPEN' THEN 'open'
  WHEN l.state = 'CLOSED' THEN 'closed' ELSE 'no-pr' END`;
const SERIES_COLUMN: Record<Split, string> = { phase: PHASE, model: 't.model', where: 't.ran_where', outcome: OUTCOME };

/**
 * Reads the page's figures from the split totals and the branch links, never
 * from the request rows: a public page view must not spend the free plan's
 * read allowance on the table that grows with every request.
 */
export async function costsPage(db: D1Database, query: CostQuery, now = Date.now()): Promise<CostsPage> {
  const first = firstDay(query.period, now);
  // What narrows a request: its phase, model and agent, then the engineer its pull request names.
  const narrowing: string[] = [];
  const narrowBinds: (string | number)[] = [];
  if (query.category !== null) {
    narrowing.push(`${PHASE} = ?`);
    narrowBinds.push(query.category);
  }
  if (query.model !== null) {
    narrowing.push('t.model = ?');
    narrowBinds.push(query.model);
  }
  if (query.who !== 'all') narrowing.push(`t.subagent = ${query.who === 'subagents' ? 1 : 0}`);
  const byEngineer: string[] = [];
  const engineerBinds: string[] = [];
  if (query.engineer === UNATTRIBUTED) byEngineer.push('l.branch IS NULL');
  else if (query.engineer !== null) {
    byEngineer.push('l.engineer = ?');
    engineerBinds.push(query.engineer);
  }
  const where = [...(first === null ? [] : ['t.day >= ?']), ...narrowing, ...byEngineer];
  const binds = [...(first === null ? [] : [first]), ...narrowBinds, ...engineerBinds];
  const needsLinks = query.group !== 'day' || query.engineer !== null || query.split === 'outcome';
  const conditions = where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`;
  // The phase is read only for a by-category question; the split's own column is read always.
  const phase = query.group === 'category' ? PHASE : "''";
  const phaseKey = query.group === 'category' ? `, ${PHASE}` : '';
  const series = SERIES_COLUMN[query.split];
  // A by-day question needs no branch unless it filters by engineer or splits by outcome, which are the things a link says.
  const select =
    query.group === 'day'
      ? `SELECT t.day AS day, '' AS branch, '' AS category, ${series} AS series, SUM(t.cost_micros) AS costMicros,
           SUM(t.unpriced_requests) AS unpricedRequests, MAX(t.last_at) AS lastAt,
           NULL AS prNumber, NULL AS title, NULL AS state, NULL AS mergedAt, NULL AS issue, NULL AS engineer,
           NULL AS linesAdded, NULL AS linesRemoved, NULL AS openedAt, NULL AS ciRounds, NULL AS localRounds, NULL AS findings, NULL AS issueTitle
         FROM daily_split_totals t ${needsLinks ? 'LEFT JOIN branch_links l ON l.branch = t.branch' : ''}
         ${conditions} GROUP BY t.day, ${series}`
      : `SELECT '' AS day, t.branch AS branch, ${phase} AS category, ${series} AS series, SUM(t.cost_micros) AS costMicros,
           SUM(t.unpriced_requests) AS unpricedRequests, MAX(t.last_at) AS lastAt,
           l.pr_number AS prNumber, l.title AS title, l.state AS state, l.merged_at AS mergedAt,
           l.issue_number AS issue, l.engineer AS engineer,
           s.lines_added AS linesAdded, s.lines_removed AS linesRemoved, s.opened_at AS openedAt,
           s.ci_rounds AS ciRounds, s.local_rounds AS localRounds, s.findings AS findings, s.issue_title AS issueTitle
         FROM daily_split_totals t LEFT JOIN branch_links l ON l.branch = t.branch
         LEFT JOIN pull_request_stats s ON s.pr_number = l.pr_number
         ${conditions} GROUP BY t.branch${phaseKey}, ${series}`;

  const windows = windowsOf(query.period, now);
  const narrow = { narrowing, narrowBinds, byEngineer, engineerBinds };
  // The comparison and the Over time charts read the same sessions and merged pull requests, from the previous window on.
  const reads = windows === null && query.group !== 'day' ? [] : trendReads(db, query, windows?.previous.from ?? first, narrow);
  const [rows, engineers, models, state, runs, list, dimensionRows, sessionRows, pullRequestRows] = await db.batch([
    db.prepare(select).bind(...binds),
    db.prepare('SELECT DISTINCT engineer FROM branch_links WHERE engineer IS NOT NULL ORDER BY engineer'),
    db.prepare('SELECT DISTINCT model FROM daily_split_totals ORDER BY model'),
    db.prepare('SELECT last_success_at AS lastSuccessAt FROM link_state WHERE id = 1'),
    ...jobReads(db),
    // Dollars per window under every way of splitting; one read, whatever the grouping.
    windows === null ? db.prepare('SELECT 1 WHERE 0') : dimensionRead(db, windows, narrow),
    ...reads,
  ]);
  const lastLinkSuccessAt = (state!.results[0] as { lastSuccessAt: number | null } | undefined)?.lastSuccessAt ?? null;
  const groups = groupRows(rows!.results as unknown as TotalRow[], query.group, lastLinkSuccessAt, query.sort);
  const bySeries = bag();
  for (const g of groups) for (const [key, micros] of Object.entries(g.bySeries)) bySeries[key] = (bySeries[key] ?? 0) + micros;
  return {
    query,
    engineers: (engineers!.results as { engineer: string }[]).map((e) => e.engineer),
    models: (models!.results as { model: string }[]).map((m) => m.model),
    groups,
    series: seriesOf(query.split, bySeries),
    bySeries,
    totalMicros: groups.reduce((sum, g) => sum + g.totalMicros, 0),
    lastLinkSuccessAt,
    jobs: jobStatuses(runs!, list!, lastLinkSuccessAt),
    trends:
      sessionRows === undefined || query.group !== 'day'
        ? null
        : trends(
            (sessionRows.results as unknown as SessionStart[]).filter((r) => first === null || r.day >= first),
            mergedPullRequests(pullRequestRows!.results as unknown as MergedRow[]).filter((r) => first === null || r.day >= first),
            query.period,
            now,
          ),
    comparison:
      windows === null
        ? null
        : comparisonOf(windows, dimensionRows!.results as unknown as DimensionRow[], sessionRows!.results as unknown as SessionStart[], mergedPullRequests(pullRequestRows!.results as unknown as MergedRow[])),
  };
}

interface DimensionRow {
  inPeriod: number;
  phase: string;
  model: string;
  ranWhere: string;
  outcome: string;
  costMicros: number;
}

/** Dollars per phase, model, place and outcome in each window, under the page's filters. */
function dimensionRead(db: D1Database, windows: NonNullable<ReturnType<typeof windowsOf>>, f: Narrowing) {
  const where = ['t.day >= ?', ...f.narrowing, ...f.byEngineer];
  return db
    .prepare(
      `SELECT CASE WHEN t.day >= ? THEN 1 ELSE 0 END AS inPeriod, ${PHASE} AS phase, t.model AS model, t.ran_where AS ranWhere, ${OUTCOME} AS outcome, SUM(t.cost_micros) AS costMicros
       FROM daily_split_totals t LEFT JOIN branch_links l ON l.branch = t.branch
       WHERE ${where.join(' AND ')} GROUP BY 1, 2, 3, 4, 5`,
    )
    .bind(windows.current.from, windows.previous.from, ...f.narrowBinds, ...f.engineerBinds);
}

/** Splits what the reads returned at the period's first day, and compares the two halves. */
function comparisonOf(windows: NonNullable<ReturnType<typeof windowsOf>>, dimensions: DimensionRow[], sessions: SessionStart[], merged: MergedPullRequest[]): Comparison {
  const figures = (inPeriod: boolean) => {
    const by: Record<Split, Record<string, number>> = { phase: bag(), model: bag(), where: bag(), outcome: bag() };
    for (const r of dimensions.filter((d) => (d.inPeriod === 1) === inPeriod)) {
      for (const [split, key] of [['phase', r.phase], ['model', r.model], ['where', r.ranWhere], ['outcome', r.outcome]] as const) by[split][key] = (by[split][key] ?? 0) + r.costMicros;
    }
    const inWindow = (day: string) => (day >= windows.current.from) === inPeriod;
    return windowFigures(by, sessions.filter((s) => inWindow(s.day)), merged.filter((p) => inWindow(p.day)));
  };
  return compare(figures(true), figures(false), windows);
}

interface Narrowing {
  narrowing: string[];
  narrowBinds: (string | number)[];
  byEngineer: string[];
  engineerBinds: string[];
}

/**
 * The reads behind the trend charts. Starting context follows the period, the
 * engineer and the model alone, from the sessions' first main-agent requests.
 * Pull request size and cost per line follow every filter, over the pull
 * requests merged in the period, each with its whole cost: a pull request with
 * no request that passes the filters is not in them.
 */
function trendReads(db: D1Database, query: CostQuery, first: string | null, f: Narrowing) {
  const since = first === null ? [] : [first];
  const starts = [...(first === null ? [] : ['ss.day >= ?']), ...(query.model === null ? [] : ['ss.model = ?']), ...f.byEngineer];
  const merged = ["l.state = 'MERGED' AND l.merged_at IS NOT NULL", ...(first === null ? [] : ['substr(l.merged_at, 1, 10) >= ?']), ...f.narrowing, ...f.byEngineer];
  return [
    db
      .prepare(
        `SELECT ss.day AS day, ss.input_tokens + ss.cache_creation_tokens + ss.cache_read_tokens AS tokens
         FROM session_starts ss ${query.engineer === null ? '' : 'LEFT JOIN branch_links l ON l.branch = ss.branch'}
         ${starts.length === 0 ? '' : `WHERE ${starts.join(' AND ')}`}`,
      )
      .bind(...since, ...(query.model === null ? [] : [query.model]), ...f.engineerBinds),
    db
      .prepare(
        `SELECT l.pr_number AS pr, substr(l.merged_at, 1, 10) AS day, s.lines_added + s.lines_removed AS lines, ${PHASE} AS category, SUM(t.cost_micros) AS costMicros
         FROM daily_split_totals t JOIN branch_links l ON l.branch = t.branch
         LEFT JOIN pull_request_stats s ON s.pr_number = l.pr_number
         WHERE ${merged.join(' AND ')}
         GROUP BY l.pr_number, ${PHASE}`,
      )
      .bind(...since, ...f.narrowBinds, ...f.engineerBinds),
  ];
}

interface MergedRow {
  pr: number;
  day: string;
  lines: number | null;
  category: string;
  costMicros: number;
}

/** One entry per merged pull request, from the per-phase rows the query returns for it. */
function mergedPullRequests(rows: MergedRow[]): MergedPullRequest[] {
  const found = new Map<number, MergedPullRequest>();
  for (const r of rows) {
    const p = found.get(r.pr) ?? { day: r.day, lines: r.lines, costByPhase: {} };
    p.costByPhase[r.category] = (p.costByPhase[r.category] ?? 0) + r.costMicros;
    found.set(r.pr, p);
  }
  return [...found.values()];
}
