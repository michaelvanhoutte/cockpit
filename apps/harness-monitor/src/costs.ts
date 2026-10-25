import { addDays, belgianDay, formatDate, formatDay, startOfDay, weekStart } from './belgium';
import { jobReads, jobStatuses, type JobStatus } from './jobs';
import { CATEGORIES, PHASES_BEGIN, totalsPhaseSql, WHERE, type Category } from './validate';

/** The phase a totals row counts as: the stored one, except Building before phase marks existed. */
const PHASE = totalsPhaseSql('t.');

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

/** What the dollars are coloured by: the "where it went" bar, the per-day charts and each row's bar. */
export const SPLITS = ['phase', 'engineer', 'model', 'where', 'outcome'] as const;
export type Split = (typeof SPLITS)[number];
/** Which requests count: all of them, a session's own agent, or the subagents it started. */
export const WHOS = ['all', 'main', 'subagents'] as const;
export type Who = (typeof WHOS)[number];
/** A model id as the usage hook sends it: letters, digits and a few separators, never free text. */
export const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:\[\]-]{0,99}$/;

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

/** The colouring a grouping already is, which would repeat its rows: never offered, and an address asking for it falls back. */
export const SAME_AS_ROWS: Partial<Record<Group, Split>> = { engineer: 'engineer', category: 'phase' };
const INSTEAD: Record<Split, Split> = { phase: 'engineer', engineer: 'phase', model: 'phase', where: 'phase', outcome: 'phase' };

export function parseQuery(params: URLSearchParams): CostQuery {
  const period = params.get('period') as Period;
  const group = params.get('group') as Group;
  const category = params.get('category') as Category;
  const split = params.get('split') as Split;
  const who = params.get('who') as Who;
  const model = params.get('model') ?? '';
  const page = Number(params.get('page'));
  const group_ = (GROUPS as readonly string[]).includes(group) ? group : DEFAULT_GROUP;
  const asked: Split = (SPLITS as readonly string[]).includes(split) ? split : 'phase';
  return {
    // Own keys only: `in` would accept `toString` and the page would throw.
    period: period !== null && Object.hasOwn(PERIODS, period) ? period : '30d',
    // A filter that repeats the rows is dropped, as its control is not offered.
    engineer: group_ === 'engineer' ? null : params.get('engineer') || null,
    category: group_ !== 'category' && (CATEGORIES as readonly string[]).includes(category) ? category : null,
    model: MODEL_ID.test(model) ? model : null,
    who: (WHOS as readonly string[]).includes(who) ? who : 'all',
    group: group_,
    split: SAME_AS_ROWS[group_] === asked ? INSTEAD[asked] : asked,
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

/** The first Belgian day inside the period, or null for all time. */
export function firstDay(period: Period, now: number): string | null {
  const days = PERIODS[period];
  return days === null ? null : addDays(belgianDay(now), -(days - 1));
}

/** A run of Belgian days, both ends included. */
export interface DayWindow {
  from: string;
  to: string;
}

/** The period's window and the one before it, of the same length; null for all time, which has no before. The Claude calls page compares them. */
export function windowsOf(period: Period, now: number): { current: DayWindow; previous: DayWindow } | null {
  const days = PERIODS[period];
  if (days === null) return null;
  const today = belgianDay(now);
  const from = addDays(today, -(days - 1));
  return { current: { from, to: today }, previous: { from: addDays(from, -days), to: addDays(from, -1) } };
}

/** One series' dollars and tokens in one place, as the totals table holds them. */
export interface TotalRow {
  /** The Belgian day, for a by-day query; '' otherwise. */
  day: string;
  /** '' for requests that ran on no branch. */
  branch: string;
  /** The row's phase when the page groups by category; '' otherwise. */
  category: string;
  /** Which series of the split this is: a phase, model, place or outcome key. */
  series: string;
  costMicros: number;
  unpricedRequests: number;
  /** Every request's tokens, priced or not. */
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
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
  /** The closing issue's title. */
  issueTitle: string | null;
  /** The issue's parent and its title; null for an issue with none, or until linking has read it. */
  issueParent: number | null;
  issueParentTitle: string | null;
  /** By pull request only: 1 when the row's cost is credited to a pull request its own branch does not have. */
  credited: number;
  /** By pull request only: the issue that credited pull request closes, if any. */
  creditIssue: number | null;
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
  /** Lines added and removed, leaving out lockfiles, snapshots and generated files; null until sized. */
  lines: { added: number; removed: number } | null;
  /** Distinct pull requests in the group. */
  pullRequests: number;
  /** Dollars per series key of the split; a key the group has none of is absent. */
  bySeries: Record<string, number>;
  totalMicros: number;
  unpricedRequests: number;
  /** Every request's tokens, priced or not, by kind. */
  tokens: { input: number; output: number; cacheWrite: number; cacheRead: number };
  /** All four kinds summed, per series key of the split; a key the group has none of is absent. */
  tokensBySeries: Record<string, number>;
  totalTokens: number;
}

/** The engineer colouring's key for a linked pull request whose author is not known. */
export const UNKNOWN_ENGINEER = '~unknown';

/** A model id is free text, so series dollars live in an object with no prototype: no id can be `__proto__`. */
const bag = (): Record<string, number> => Object.create(null) as Record<string, number>;

/** One colour of the split: its key, its name, and the short name over a column where a page draws one (the Claude calls page does). */
export interface Series {
  key: string;
  label: string;
  short: string;
}

const WHERE_NAMES: Record<(typeof WHERE)[number], string> = { local: "Engineers' machines", cloud: 'Cloud sessions', actions: 'CI (GitHub Actions)' };
const WHERE_SERIES: Series[] = WHERE.map((key) => ({ key, label: WHERE_NAMES[key], short: WHERE_NAMES[key] }));
/** In stacking order: the grey one, No pull request, stacks last (src/palette.ts). */
const OUTCOME_SERIES: Series[] = [
  { key: 'merged', label: 'Merged', short: 'Merged' },
  { key: 'open', label: 'Still open', short: 'Still open' },
  { key: 'closed', label: 'Closed unmerged', short: 'Closed unmerged' },
  { key: 'on-main', label: 'On main', short: 'On main' },
  { key: 'no-pr', label: 'No pull request', short: 'No pull request' },
];

const NAMES: Record<Category, string> = {
  unphased: 'Unphased',
  'outside-process': 'Outside the process',
  'scoping-planning': 'Scoping & planning',
  building: 'Building',
  'local-code-review': 'Local code review',
  'local-security-review': 'Local security review',
  'after-push': 'After push',
  'ci-reviews': 'CI reviews',
  'process-review': 'Process review',
};
export const categoryName = (c: Category) => NAMES[c];

/**
 * The colours of a split, in order. Phases, places and outcomes are fixed;
 * models are the ones with any of the totals given, biggest first.
 */
export function seriesOf(split: Split, totals: Record<string, number>): Series[] {
  switch (split) {
    case 'phase':
      return CATEGORIES.filter((c) => c !== 'unphased' || (totals.unphased ?? 0) > 0).map((c) => ({ key: c, label: categoryName(c), short: categoryName(c) }));
    case 'where':
      return WHERE_SERIES;
    case 'outcome':
      return OUTCOME_SERIES;
    case 'model':
      return Object.keys(totals)
        .filter((m) => totals[m]! > 0)
        .sort((a, b) => totals[b]! - totals[a]! || a.localeCompare(b))
        .map((m) => ({ key: m, label: m, short: m }));
    case 'engineer':
      // Engineers dearest first; requests no pull request claims last.
      return Object.keys(totals)
        .filter((e) => totals[e]! > 0)
        .sort((a, b) => Number(a === UNATTRIBUTED) - Number(b === UNATTRIBUTED) || totals[b]! - totals[a]! || a.localeCompare(b))
        .map((e) => {
          const label = e === UNATTRIBUTED ? 'Unattributed' : e === UNKNOWN_ENGINEER ? 'unknown' : e;
          return { key: e, label, short: label };
        });
  }
}

/** Where a row belongs for a grouping: its key, label and the second line, or what is known of its pull request. */
function placeOf(row: TotalRow, group: Group) {
  const linked = row.prNumber !== null;
  switch (group) {
    case 'category':
      return { key: row.category, label: categoryName(row.category as Category), sub: null, catchAll: false };
    case 'day':
      return { key: row.day, label: formatDay(row.day), sub: null, catchAll: false };
    case 'engineer':
      return linked
        ? { key: row.engineer ?? '~unknown', label: row.engineer ?? 'unknown', sub: null, catchAll: row.engineer === null }
        : { key: UNATTRIBUTED, label: 'Unattributed', sub: null, catchAll: true };
    case 'issue':
      if (!linked) return { key: UNATTRIBUTED, label: 'Unattributed', sub: null, catchAll: true };
      // A child's cost joins its parent's row, so a run built as several pull requests is one row beside its twin built as one.
      return row.issue === null
        ? { key: '~none', label: 'No issue', sub: null, catchAll: true }
        : { key: `issue-${rowIssue(row)}`, label: issueLabel(rowIssue(row), rowIssueTitle(row)), sub: null, catchAll: false };
    case 'pr':
      // A single named branch no pull request names is one branch, not a catch-all, so it keeps its bar.
      return linked
        ? {
            key: `pr-${row.prNumber}`,
            label: `#${row.prNumber} ${row.title}`,
            sub: row.issue === null ? 'No issue' : `Issue #${row.issue}`,
            catchAll: false,
          }
        : // The second line of a branch no pull request names is settled once all its rows are in: see `groupRows`.
          { key: `branch-${row.branch}`, label: row.branch === '' ? 'No branch' : row.branch, sub: 'unattributed', catchAll: row.branch === '' };
  }
}

/** The issue a by-issue row counts a pull request under: its parent where it has one, else the issue itself. */
const rowIssue = (row: TotalRow) => row.issueParent ?? row.issue!;
/** That issue's title: the parent's, or the issue's own where it has no parent. */
const rowIssueTitle = (row: TotalRow) => (row.issueParent !== null ? row.issueParentTitle : row.issueTitle);

/** An issue as a row names it: "#N title", or "#N" until its title has been read. */
const issueLabel = (number: number, title: string | null) => (title ? `#${number} ${title}` : `#${number}`);

const mergedOf = (row: TotalRow) =>
  row.prNumber === null ? null : row.mergedAt !== null ? formatDate(Date.parse(row.mergedAt)) : (row.state ?? '').toLowerCase();

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
 * time the credit was last good through (linking has caught up and a rebuild
 * has seen it) is "linking…", its pull request or its credit not being known
 * yet. Otherwise a branch no pull request names reads the issue its credited
 * requests went to ("several issues" for more than one), else "unattributed".
 */
export function groupRows(rows: TotalRow[], group: Group, creditedThrough: number | null, sort: Sort = 'default'): CostGroup[] {
  const groups = new Map<string, CostGroup>();
  const prs = new Map<string, Set<number>>();
  const recency = new Map<string, Recency>();
  /** A branch no pull request names: its newest request, and the issues its credited requests went to. */
  const branches = new Map<string, { lastAt: number; credited: boolean; issues: Set<number> }>();
  for (const row of rows) {
    const place = placeOf(row, group);
    let g = groups.get(place.key);
    if (!g) {
      g = { ...place, prNumber: group === 'pr' ? row.prNumber : null, issue: group === 'pr' ? row.issue : group === 'issue' && row.issue !== null ? rowIssue(row) : null, engineer: row.prNumber === null ? null : row.engineer, merged: mergedOf(row), pullRequests: 0, lines: row.linesAdded !== null && row.linesRemoved !== null ? { added: row.linesAdded, removed: row.linesRemoved } : null, bySeries: bag(), totalMicros: 0, unpricedRequests: 0, tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }, tokensBySeries: bag(), totalTokens: 0 };
      groups.set(place.key, g);
      prs.set(place.key, new Set());
    }
    g.bySeries[row.series] = (g.bySeries[row.series] ?? 0) + row.costMicros;
    g.totalMicros += row.costMicros;
    g.unpricedRequests += row.unpricedRequests;
    const rowTokens = row.inputTokens + row.outputTokens + row.cacheCreationTokens + row.cacheReadTokens;
    g.tokens.input += row.inputTokens;
    g.tokens.output += row.outputTokens;
    g.tokens.cacheWrite += row.cacheCreationTokens;
    g.tokens.cacheRead += row.cacheReadTokens;
    g.tokensBySeries[row.series] = (g.tokensBySeries[row.series] ?? 0) + rowTokens;
    g.totalTokens += rowTokens;
    // Two pull requests on one issue may have been read apart, one before the title was.
    if (group === 'issue' && row.issue !== null && rowIssueTitle(row) && g.label === issueLabel(rowIssue(row), null)) g.label = issueLabel(rowIssue(row), rowIssueTitle(row));
    if (row.prNumber !== null) prs.get(place.key)!.add(row.prNumber);
    if (group === 'pr' && row.prNumber === null && row.branch !== '') {
      const branch = branches.get(place.key) ?? { lastAt: 0, credited: false, issues: new Set<number>() };
      branch.lastAt = Math.max(branch.lastAt, row.lastAt);
      if (row.credited === 1) {
        branch.credited = true;
        if (row.creditIssue !== null) branch.issues.add(row.creditIssue);
      }
      branches.set(place.key, branch);
    }
    const r = recencyOf(row);
    const best = recency.get(place.key);
    if (!best || newer(r, best) < 0) recency.set(place.key, r);
  }
  for (const [key, g] of groups) g.pullRequests = prs.get(key)!.size;
  for (const [key, branch] of branches) {
    groups.get(key)!.sub =
      creditedThrough === null || branch.lastAt > creditedThrough
        ? 'linking…'
        : !branch.credited
          ? 'unattributed'
          : branch.issues.size === 0
            ? 'No issue'
            : branch.issues.size === 1
              ? `Issue #${[...branch.issues][0]}`
              : 'several issues';
  }
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

/** What a per-day chart counts: dollars, in micros, or the four kinds of token summed. */
export type Measure = 'cost' | 'tokens';

/** One line of a per-day chart: a series' measure on every day of the range. */
export interface DayLine {
  key: string;
  label: string;
  /** One value per day, in micros or tokens; 0 for a day with none. */
  values: number[];
}

export interface DayChart {
  /** Every Belgian day from the first to the last, oldest first. */
  days: string[];
  /** A line per series with any of the measure. */
  lines: DayLine[];
  /** The total's measure on each day. */
  total: number[];
}

/** A day's group as a per-day chart reads it; the calls page has dollars only, so tokens are optional. */
export type DayGroup = Pick<CostGroup, 'key' | 'bySeries' | 'totalMicros'> & Partial<Pick<CostGroup, 'tokensBySeries' | 'totalTokens'>>;

/**
 * Cost or tokens per day as lines: one per series of the split that has any,
 * and the total. The range runs from the period's first day (the earliest day
 * with any request, priced or not, for all time) to today, so a day with none
 * is a zero, not a gap.
 */
export function dayChart(groups: DayGroup[], series: Series[], first: string | null, now: number, measure: Measure = 'cost'): DayChart {
  if (groups.length === 0) return { days: [], lines: [], total: [] };
  const of = (g: DayGroup | undefined, key: string) => (measure === 'cost' ? g?.bySeries[key] : g?.tokensBySeries?.[key]) ?? 0;
  const totalOf = (g: DayGroup | undefined) => (measure === 'cost' ? g?.totalMicros : g?.totalTokens) ?? 0;
  const byDay = new Map(groups.map((g) => [g.key, g]));
  const keys = groups.map((g) => g.key).sort();
  const start = first ?? keys[0]!;
  const today = belgianDay(now);
  const end = today > keys.at(-1)! ? today : keys.at(-1)!;
  const days: string[] = [];
  for (let day = start; day <= end; day = addDays(day, 1)) days.push(day);
  const lines = series
    .filter((s) => groups.some((g) => of(g, s.key) > 0))
    .map((s) => ({ key: s.key, label: s.label, values: days.map((d) => of(byDay.get(d), s.key)) }));
  return { days, lines, total: days.map((d) => totalOf(byDay.get(d))) };
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
  /** The first Belgian day of each bucket, oldest first: a day, or the Monday of a week. */
  buckets: string[];
  weekly: boolean;
  /** Median tokens in a session's first main-agent request. */
  startingContext: (number | null)[];
  /** Median lines changed per merged pull request. */
  prSize: (number | null)[];
  /** Micros per 1,000 lines changed: the total first, then each phase that is drawn anywhere. */
  costPerThousandLines: TrendLine[];
}

/**
 * The charts' values per bucket: days for 7 and 30 days, weeks (starting
 * Monday) otherwise. A bucket with nothing to show holds null, not zero.
 * Cost per line divides the merged pull requests' cost by their thousands of
 * lines, leaving out a pull request with no counted lines from both. A phase
 * is not drawn before it was recorded: every phase but Unphased only from the
 * day phase marks began. Unphased is drawn before then, and after it only in a
 * bucket that holds some, since a hook on an older checkout still sends it.
 */
export function trends(sessions: SessionStart[], pullRequests: MergedPullRequest[], period: Period, now: number): Trends {
  const weekly = period !== '7d' && period !== '30d';
  const bucketOf = (day: string) => (weekly ? weekStart(day) : day);
  const span = weekly ? 7 : 1;
  const today = belgianDay(now);
  const earliest = [...sessions.map((s) => s.day), ...pullRequests.map((p) => p.day)].sort()[0];
  const first = firstDay(period, now) ?? earliest;
  const buckets: string[] = [];
  if (first !== undefined) for (let bucket = bucketOf(first); bucket <= today; bucket = addDays(bucket, span)) buckets.push(bucket);

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
  const drawn = (phase: string, bucket: string, cost: number) => {
    const last = addDays(bucket, span - 1);
    return phase === 'unphased' ? bucket < PHASES_BEGIN || cost > 0 : last >= PHASES_BEGIN;
  };
  const phaseLines = CATEGORIES.map((c) => ({
    key: c as string,
    label: categoryName(c),
    values: buckets.map((b, i) => {
      if (counted[i]!.length === 0) return null;
      const value = perThousand(counted[i]!, c);
      return drawn(c, b, value) ? value : null;
    }),
  })).filter((l) => l.values.some((v) => v !== null && v > 0));
  return {
    buckets,
    weekly,
    startingContext: tokens.map((t) => (t.length === 0 ? null : median(t))),
    prSize: sizes.map((s) => (s.length === 0 ? null : median(s))),
    costPerThousandLines: [{ key: 'total', label: 'All phases', values: counted.map((prs) => (prs.length === 0 ? null : perThousand(prs, null))) }, ...phaseLines],
  };
}

export interface CostsPage {
  query: CostQuery;
  engineers: string[];
  /** Every model with dollars on record, for the Model filter. */
  models: string[];
  groups: CostGroup[];
  /** The split's columns, in order. */
  series: Series[];
  /** The split's series with tokens, for Tokens per day: a model with no price still has its line. */
  tokenSeries: Series[];
  /** Per series key, over every group (not only the shown page). */
  bySeries: Record<string, number>;
  totalMicros: number;
  /** Epoch milliseconds; null while linking has never succeeded. */
  lastLinkSuccessAt: number | null;
  /** Epoch milliseconds the credit is good through: when linking last caught up, as the last rebuild saw it; null until a rebuild has. */
  creditedThrough: number | null;
  /** What each job last did: read in the same batch as the figures. */
  jobs: JobStatus[];
  /** The Over time page's trend charts; null for every other grouping. */
  trends: Trends | null;
}

/**
 * The pull request a total counts under: its own branch's link `l`, else the link of the branch it is credited to `e`
 * (joined only where `l` is missing, so a branch that has since got a pull request of its own is counted under it).
 */
const LINKS = `LEFT JOIN branch_links l ON l.branch = t.branch
         LEFT JOIN branch_links e ON l.branch IS NULL AND e.branch = t.credit_branch`;
/** A column of the pull request a total counts under. */
const counted = (column: string) => `COALESCE(l.${column}, e.${column})`;
/** Where a request's pull request stands, from its branch and the link GitHub linking stored. */
const OUTCOME = `CASE WHEN t.branch = 'main' AND e.branch IS NULL THEN 'on-main' WHEN ${counted('state')} = 'MERGED' THEN 'merged' WHEN ${counted('state')} = 'OPEN' THEN 'open'
  WHEN ${counted('state')} = 'CLOSED' THEN 'closed' ELSE 'no-pr' END`;
/** Whose pull request a request belongs to: the author, "unknown" for a linked pull request without one, Unattributed for none. */
const ENGINEER = `CASE WHEN ${counted('branch')} IS NULL THEN '${UNATTRIBUTED}' ELSE COALESCE(${counted('engineer')}, '${UNKNOWN_ENGINEER}') END`;
const SERIES_COLUMN: Record<Split, string> = { phase: PHASE, engineer: ENGINEER, model: 't.model', where: 't.ran_where', outcome: OUTCOME };
/** Every request's tokens by kind, priced or not: read for every grouping, drawn for each day alone. */
const TOKEN_SUMS = `SUM(t.input_tokens) AS inputTokens, SUM(t.output_tokens) AS outputTokens,
           SUM(t.cache_creation_tokens) AS cacheCreationTokens, SUM(t.cache_read_tokens) AS cacheReadTokens`;

/**
 * Reads the page's figures from the credited totals and the branch links, never
 * from the request rows: a public page view must not spend the free plan's
 * read allowance on the table that grows with every request.
 */
export async function costsPage(db: D1Database, query: CostQuery, now = Date.now()): Promise<CostsPage> {
  const first = firstDay(query.period, now);
  // What narrows a request: its phase, model and agent, then the engineer its pull request (or the one it is credited to) names.
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
  if (query.engineer === UNATTRIBUTED) byEngineer.push(`${counted('branch')} IS NULL`);
  else if (query.engineer !== null) {
    byEngineer.push(`${counted('engineer')} = ?`);
    engineerBinds.push(query.engineer);
  }
  const where = [...(first === null ? [] : ['t.day >= ?']), ...narrowing, ...byEngineer];
  const binds = [...(first === null ? [] : [first]), ...narrowBinds, ...engineerBinds];
  const needsLinks = query.group !== 'day' || query.engineer !== null || query.split === 'outcome' || query.split === 'engineer';
  const conditions = where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`;
  // The phase is read only for a by-category question; the split's own column is read always.
  const phase = query.group === 'category' ? PHASE : "''";
  const phaseKey = query.group === 'category' ? `, ${PHASE}` : '';
  const series = SERIES_COLUMN[query.split];
  // A pull request's own row is the pull request its branch names; every other grouping counts credited cost under the pull request it is credited to.
  const byPullRequest = query.group === 'pr';
  const link = (column: string) => (byPullRequest ? `l.${column}` : counted(column));
  // A by-day question needs no branch unless it filters by engineer or colours by outcome or engineer, which are the things a link says.
  const select =
    query.group === 'day'
      ? `SELECT t.day AS day, '' AS branch, '' AS category, ${series} AS series, SUM(t.cost_micros) AS costMicros,
           SUM(t.unpriced_requests) AS unpricedRequests, MAX(t.last_at) AS lastAt, ${TOKEN_SUMS},
           NULL AS prNumber, NULL AS title, NULL AS state, NULL AS mergedAt, NULL AS issue, NULL AS engineer,
           NULL AS linesAdded, NULL AS linesRemoved, NULL AS openedAt, NULL AS issueTitle,
           NULL AS issueParent, NULL AS issueParentTitle, 0 AS credited, NULL AS creditIssue
         FROM daily_credited_totals t ${needsLinks ? LINKS : ''}
         ${conditions} GROUP BY t.day, ${series}`
      : `SELECT '' AS day, t.branch AS branch, ${phase} AS category, ${series} AS series, SUM(t.cost_micros) AS costMicros,
           SUM(t.unpriced_requests) AS unpricedRequests, MAX(t.last_at) AS lastAt, ${TOKEN_SUMS},
           ${link('pr_number')} AS prNumber, ${link('title')} AS title, ${link('state')} AS state, ${link('merged_at')} AS mergedAt,
           ${link('issue_number')} AS issue, ${link('engineer')} AS engineer,
           s.lines_added AS linesAdded, s.lines_removed AS linesRemoved, s.opened_at AS openedAt, s.issue_title AS issueTitle,
           ${link('issue_parent')} AS issueParent, ${link('issue_parent_title')} AS issueParentTitle,
           ${byPullRequest ? 'CASE WHEN e.branch IS NULL THEN 0 ELSE 1 END' : '0'} AS credited, ${byPullRequest ? 'e.issue_number' : 'NULL'} AS creditIssue
         FROM daily_credited_totals t ${LINKS}
         LEFT JOIN pull_request_stats s ON s.pr_number = ${link('pr_number')}
         ${conditions} GROUP BY t.branch, e.branch${phaseKey}, ${series}`;

  // Only the Over time page draws the trend charts, so only it reads their sessions and merged pull requests.
  const reads = query.group === 'day' ? trendReads(db, query, first, { narrowing, narrowBinds }) : [];
  const [rows, engineers, models, state, runs, list, sessionRows, pullRequestRows] = await db.batch([
    db.prepare(select).bind(...binds),
    db.prepare('SELECT DISTINCT engineer FROM branch_links WHERE engineer IS NOT NULL ORDER BY engineer'),
    db.prepare('SELECT DISTINCT model FROM daily_credited_totals ORDER BY model'),
    db.prepare('SELECT last_success_at AS lastSuccessAt, credited_through AS creditedThrough FROM link_state WHERE id = 1'),
    ...jobReads(db),
    ...reads,
  ]);
  const linkState = state!.results[0] as { lastSuccessAt: number | null; creditedThrough: number | null } | undefined;
  const lastLinkSuccessAt = linkState?.lastSuccessAt ?? null;
  const creditedThrough = linkState?.creditedThrough ?? null;
  const groups = groupRows(rows!.results as unknown as TotalRow[], query.group, creditedThrough, query.sort);
  const bySeries = bag();
  for (const g of groups) for (const [key, micros] of Object.entries(g.bySeries)) bySeries[key] = (bySeries[key] ?? 0) + micros;
  const tokensBySeries = bag();
  for (const g of groups) for (const [key, n] of Object.entries(g.tokensBySeries)) tokensBySeries[key] = (tokensBySeries[key] ?? 0) + n;
  return {
    query,
    engineers: (engineers!.results as { engineer: string }[]).map((e) => e.engineer),
    models: (models!.results as { model: string }[]).map((m) => m.model),
    groups,
    series: seriesOf(query.split, bySeries),
    tokenSeries: seriesOf(query.split, tokensBySeries),
    bySeries,
    totalMicros: groups.reduce((sum, g) => sum + g.totalMicros, 0),
    lastLinkSuccessAt,
    creditedThrough,
    jobs: jobStatuses(runs!, list!, lastLinkSuccessAt),
    trends:
      sessionRows === undefined || query.group !== 'day'
        ? null
        : trends(
            sessionRows.results as unknown as SessionStart[],
            mergedPullRequests(pullRequestRows!.results as unknown as MergedRow[]),
            query.period,
            now,
          ),
  };
}

interface Narrowing {
  narrowing: string[];
  narrowBinds: (string | number)[];
}

/**
 * The reads behind the trend charts. Starting context follows the period, the
 * engineer and the model alone, from the sessions' first main-agent requests;
 * a session whose first request is credited starts under the credited pull
 * request's author, as the rest of the page counts it. Pull request size and
 * cost per line follow every filter, over the pull requests merged in the
 * period, each with its own whole cost (never a credit): a pull request with
 * no request that passes the filters is not in them.
 */
function trendReads(db: D1Database, query: CostQuery, first: string | null, f: Narrowing) {
  const since = first === null ? [] : [first];
  const engineerBinds = query.engineer === null || query.engineer === UNATTRIBUTED ? [] : [query.engineer];
  const startedBy = query.engineer === UNATTRIBUTED ? 'COALESCE(l.branch, e.branch) IS NULL' : 'COALESCE(l.engineer, e.engineer) = ?';
  const starts = [...(first === null ? [] : ['ss.day >= ?']), ...(query.model === null ? [] : ['ss.model = ?']), ...(query.engineer === null ? [] : [startedBy])];
  // The merged pull request is the row, so its author is its own.
  const mergedBy = query.engineer === UNATTRIBUTED ? ['l.branch IS NULL'] : query.engineer === null ? [] : ['l.engineer = ?'];
  const merged = ["l.state = 'MERGED' AND l.merged_at IS NOT NULL", ...(first === null ? [] : ["strftime('%s', l.merged_at) * 1000 >= ?"]), ...f.narrowing, ...mergedBy];
  return [
    db
      .prepare(
        `SELECT ss.day AS day, ss.input_tokens + ss.cache_creation_tokens + ss.cache_read_tokens AS tokens
         FROM session_starts ss ${
           query.engineer === null
             ? ''
             : `LEFT JOIN branch_links l ON l.branch = ss.branch
                LEFT JOIN request_credits rc ON l.branch IS NULL AND rc.request_id = ss.request_id
                LEFT JOIN branch_links e ON e.branch = rc.credit_branch`
         }
         ${starts.length === 0 ? '' : `WHERE ${starts.join(' AND ')}`}`,
      )
      .bind(...since, ...(query.model === null ? [] : [query.model]), ...engineerBinds),
    db
      .prepare(
        `SELECT l.pr_number AS pr, l.merged_at AS mergedAt, s.lines_added + s.lines_removed AS lines, ${PHASE} AS category, SUM(t.cost_micros) AS costMicros
         FROM daily_credited_totals t JOIN branch_links l ON l.branch = t.branch
         LEFT JOIN pull_request_stats s ON s.pr_number = l.pr_number
         WHERE ${merged.join(' AND ')}
         GROUP BY l.pr_number, ${PHASE}`,
      )
      .bind(...(first === null ? [] : [startOfDay(first)]), ...f.narrowBinds, ...engineerBinds),
  ];
}

interface MergedRow {
  pr: number;
  mergedAt: string;
  lines: number | null;
  category: string;
  costMicros: number;
}

/** One entry per merged pull request, from the per-phase rows the query returns for it. */
function mergedPullRequests(rows: MergedRow[]): MergedPullRequest[] {
  const found = new Map<number, MergedPullRequest>();
  for (const r of rows) {
    const p = found.get(r.pr) ?? { day: belgianDay(Date.parse(r.mergedAt)), lines: r.lines, costByPhase: {} };
    p.costByPhase[r.category] = (p.costByPhase[r.category] ?? 0) + r.costMicros;
    found.set(r.pr, p);
  }
  return [...found.values()];
}
