import { addDays, belgianDay, startOfDay } from './belgium';
import { cycleTimeView, type CycleTimePull, type CycleTimeView, type PullCost } from './cycle-time-store';
import { number } from './page';

/**
 * What the cycle time page reads of the stored pull requests, and the
 * arithmetic over it: how a pull request's time is split, which pull requests
 * a filter keeps, how the rows are grouped and what each check held up. The
 * query only gathers; every figure the page draws is worked out here.
 */

export type Pull = CycleTimePull;

/** The Merged filter, in days; `all` is every pull request held. */
export const PERIODS = { '3d': 3, '7d': 7, all: null } as const;
export type Period = keyof typeof PERIODS;
export const PERIOD_CHOICES: [Period, string][] = [['3d', 'Last 3 days'], ['7d', 'Last 7 days'], ['all', 'Everything held']];

export const GROUPS = ['day', 'pr', 'issue', 'size', 'check'] as const;
export type Group = (typeof GROUPS)[number];
export const GROUP_LABELS: Record<Group, string> = { day: 'Over time', pr: 'Pull request', issue: 'Issue', size: 'Size', check: 'Check' };

export const SPLITS = ['phase', 'harness', 'check'] as const;
export type Split = (typeof SPLITS)[number];
export const SPLIT_LABELS: Record<Split, string> = { phase: 'Phase', harness: 'Harness', check: 'Check' };
export const TOTAL_LABELS: Record<Split, string> = { phase: 'Start to merge', harness: 'In the harness', check: 'CI rounds' };

export const SIZES = [
  { key: 'xs', label: 'Under 100 lines', max: 100 },
  { key: 's', label: '100 to 499 lines', max: 500 },
  { key: 'm', label: '500 to 1,499 lines', max: 1500 },
  { key: 'l', label: '1,500 lines or more', max: Infinity },
] as const;

/** The Rounds filter: `[value, label]`, the first meaning no filter. */
export const OUTCOMES: [string, string][] = [
  ['', 'Every pull request'],
  ['green', 'Merged on its first round'],
  ['more', 'More than one round'],
  ['red', 'Had a red round'],
  ['fluke', 'Had a fluke'],
];

export interface CycleTimeQuery {
  period: Period;
  size: string | null;
  outcome: string | null;
  group: Group;
  split: Split;
}

const DEFAULTS: CycleTimeQuery = { period: 'all', size: null, outcome: null, group: 'day', split: 'phase' };

/** The view the address asks for; anything unrecognised falls back to the default. */
export function parseCycleTimeQuery(params: URLSearchParams): CycleTimeQuery {
  const size = params.get('size');
  const outcome = params.get('outcome');
  return {
    period: (Object.keys(PERIODS) as Period[]).find((p) => p === params.get('period')) ?? DEFAULTS.period,
    size: size !== null && SIZES.some((s) => s.key === size) ? size : null,
    outcome: outcome !== null && outcome !== '' && OUTCOMES.some(([v]) => v === outcome) ? outcome : null,
    group: GROUPS.find((g) => g === params.get('group')) ?? DEFAULTS.group,
    split: SPLITS.find((s) => s === params.get('split')) ?? DEFAULTS.split,
  };
}

/** The address of a view: a query with some of it changed. Defaults are left out, so one view has one address (and one cache entry). */
export function cycleTimeAddress(q: CycleTimeQuery, over: Partial<CycleTimeQuery> = {}): string {
  const all = { ...q, ...over };
  const params = new URLSearchParams();
  for (const key of ['period', 'size', 'outcome', 'group', 'split'] as const) if (all[key] !== DEFAULTS[key]) params.set(key, String(all[key]));
  const text = params.toString();
  return text === '' ? '/cycle-time' : `/cycle-time?${text}`;
}

// ---- Reading a duration

/** 45s, 12m, 1h 05m: a time a person reads, not a stopwatch. */
export function hm(ms: number): string {
  if (ms < 59_500) return ms <= 0 ? '0m' : `${Math.round(ms / 1000)}s`;
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

export const plural = (n: number, one: string, many = `${one}s`) => `${number(n)} ${n === 1 ? one : many}`;
export const sum = (list: number[]) => list.reduce((a, b) => a + b, 0);

/** The median (the middle pair averaged on an even count) or the nearest-rank quantile; null for none. */
export function quantile(list: number[], q: number): number | null {
  if (!list.length) return null;
  const sorted = [...list].sort((a, b) => a - b);
  if (q === 0.5) {
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  }
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]!;
}

// ---- One pull request

export const lines = (p: Pull) => p.size.additions + p.size.deletions;
export const sizeOf = (p: Pull) => SIZES.find((s) => lines(p) < s.max)!;
export const redRounds = (p: Pull) => p.rounds.filter((r) => r.red).length;
export const flukeCount = (p: Pull) => p.flukes.length;
export const mergedMs = (p: Pull) => Date.parse(p.mergedAt);

/** The checks CI runs today, which the Check split names; any other a round held is drawn together as Other checks. */
const CHECKS = ['E2E (F3)', 'Test', 'Checks', 'Test Explorer', 'Contract tests'];

/** Each series of a split, in stacking order: its key and its name. Grey, the series marked `other`, stacks last, so the series beside it can take a slot grey clears. The Harness split's `reviews` is for a pull request stored with its reviews combined only, and the Check split's `other` for checks CI did not run when this was written; each is drawn only where a pull request has one. */
export const SERIES: Record<Split, { key: string; label: string; other?: boolean }[]> = {
  phase: [
    { key: 'writing', label: 'Writing' },
    { key: 'local', label: 'Local checks' },
    { key: 'ci', label: 'CI rounds' },
    { key: 'waiting', label: 'Waiting to merge' },
    { key: 'away', label: 'Away', other: true },
  ],
  harness: [
    { key: 'ci', label: 'Tests and checks' },
    { key: 'code-review', label: 'Code review' },
    { key: 'security-review', label: 'Security review' },
    { key: 'test', label: 'Test runs' },
    { key: 'browser', label: 'Browser pass' },
    { key: 'reviews', label: 'Reviews, not split by kind', other: true },
  ],
  check: [...CHECKS.map((name) => ({ key: name, label: name })), { key: 'other', label: 'Other checks', other: true }],
};

/**
 * Local checks that count towards the harness: each kind's own minutes, or null
 * where the record marked none, or where there was no round to weigh them
 * against. Null is not recorded, never zero.
 */
function localKinds(p: Pull) {
  if (p.balance === null || (p.localReviews === null && p.localRuns.test === null && p.localRuns.browser === null)) return null;
  const byKind = p.localReviews?.byKind ?? null;
  return {
    'code-review': byKind?.['code-review'].ms ?? 0,
    'security-review': byKind?.['security-review'].ms ?? 0,
    // Reviews stored without their kinds: the one figure there is.
    reviews: byKind === null ? (p.localReviews?.ms ?? 0) : 0,
    test: p.localRuns.test?.ms ?? 0,
    browser: p.localRuns.browser?.ms ?? 0,
  };
}

/** Each pull request's minutes per split, worked out once: a page asks for them once per series. */
const VALUES = new WeakMap<Pull, Partial<Record<Split, Record<string, number | null>>>>();

/**
 * A pull request's minutes per series of a split; null where its session
 * record holds none, which is not zero. The five phases add up to start to
 * merge: a pull request with no record has its writing and its local checks
 * as one figure, the time that is left.
 */
export function values(p: Pull, split: Split): Record<string, number | null> {
  const kept = VALUES.get(p)?.[split];
  if (kept) return kept;
  const made = valuesOf(p, split);
  VALUES.set(p, { ...VALUES.get(p), [split]: made });
  return made;
}

function valuesOf(p: Pull, split: Split): Record<string, number | null> {
  const ci = p.time.ciMs;
  if (split === 'phase') {
    const waiting = p.time.waitingToMergeMs ?? 0;
    return {
      writing: p.time.codingMs ?? Math.max(0, p.time.totalMs - ci - waiting - p.time.awayMs),
      local: p.time.localMs,
      ci,
      waiting,
      away: p.time.awayMs,
    };
  }
  if (split === 'harness') {
    const kinds = localKinds(p);
    return {
      ci,
      'code-review': kinds?.['code-review'] ?? null,
      'security-review': kinds?.['security-review'] ?? null,
      reviews: kinds?.reviews ?? null,
      test: kinds?.test ?? null,
      browser: kinds?.browser ?? null,
    };
  }
  const out: Record<string, number> = {};
  for (const r of p.rounds) {
    for (const c of r.checks) {
      const key = CHECKS.includes(c.name) ? c.name : 'other';
      out[key] = (out[key] ?? 0) + c.heldMs;
    }
  }
  return out;
}

/** What a split's series add up to without counting any minute twice: start to merge, the harness's own time, or the rounds'. */
export const totalOf = (p: Pull, split: Split) => (split === 'phase' ? p.time.totalMs : split === 'harness' ? (p.balance ? p.balance.harnessMs : p.time.ciMs) : p.time.ciMs);

export function matchesOutcome(p: Pull, outcome: string | null): boolean {
  if (outcome === 'green') return p.rounds.length === 1 && redRounds(p) === 0 && flukeCount(p) === 0;
  if (outcome === 'more') return p.rounds.length > 1;
  if (outcome === 'red') return redRounds(p) > 0;
  if (outcome === 'fluke') return flukeCount(p) > 0;
  return true;
}

/** Whether a pull request merged inside the period's Belgian days; `shift` 1 is the period just before it, and `all` has none. */
export function inPeriod(period: Period, now: number, shift = 0): (p: Pull) => boolean {
  const days = PERIODS[period];
  if (days === null) return () => shift === 0;
  const to = addDays(belgianDay(now), -shift * days);
  const from = addDays(to, -(days - 1));
  return (p) => belgianDay(mergedMs(p)) >= from && belgianDay(mergedMs(p)) <= to;
}

/** The pull requests the filters keep, and those the period before would have kept; a feature branch landing is in neither, since its units are counted already. */
export function filtered(pulls: Pull[], q: CycleTimeQuery, now: number): { list: Pull[]; previous: Pull[] } {
  const measured = pulls.filter((p) => !p.landing && (q.size === null || sizeOf(p).key === q.size) && matchesOutcome(p, q.outcome));
  return { list: measured.filter(inPeriod(q.period, now)), previous: measured.filter(inPeriod(q.period, now, 1)) };
}

// ---- Cost

/** The cost the Monitor holds for a pull request, or null where no request is recorded for it: no figure, never $0.00. */
export const costOf = (costs: Map<number, PullCost>, p: Pull): PullCost | null => {
  const c = costs.get(p.number);
  return c && c.requests > 0 ? c : null;
};

// ---- Totals over a list

export interface SplitTotals {
  /** Each series' minutes over the list, a null counted as nothing. */
  byKey: Map<string, number>;
  /** The series added up: a minute two kinds shared is in each. */
  all: number;
  /** The same time with each minute counted once. */
  union: number;
}

/** The series a list is drawn in: the split's own, less the combined reviews and the other checks where no pull request in the list has any. */
export function seriesOf(list: Pull[], split: Split) {
  const combined = split === 'harness' && list.some((p) => (values(p, 'harness').reviews ?? 0) > 0);
  const others = split === 'check' && list.some((p) => (values(p, 'check').other ?? 0) > 0);
  return SERIES[split].filter((s) => (s.key !== 'reviews' || combined) && (s.key !== 'other' || split !== 'check' || others));
}

export function splitTotals(list: Pull[], split: Split): SplitTotals {
  const series = seriesOf(list, split);
  const byKey = new Map(series.map((s) => [s.key, sum(list.map((p) => values(p, split)[s.key] ?? 0))]));
  return { byKey, all: sum([...byKey.values()]), union: sum(list.map((p) => totalOf(p, split))) };
}

/** Median and p95 of start to merge, against the median of the period before. */
export function startToMerge(list: Pull[], previous: Pull[]) {
  const total = list.map((p) => p.time.totalMs);
  return { median: quantile(total, 0.5), p95: quantile(total, 0.95), before: quantile(previous.map((p) => p.time.totalMs), 0.5) };
}

/** The share of writing plus harness spent in the harness, over the pull requests that have a session record to say. */
export function harnessShare(list: Pull[]) {
  const withRecord = list.filter((p) => p.balance);
  const coding = sum(withRecord.map((p) => p.balance!.codingMs));
  const harness = sum(withRecord.map((p) => p.balance!.harnessMs));
  return { share: coding + harness ? harness / (coding + harness) : null, ratio: quantile(withRecord.map((p) => p.balance!.ratio).filter((r): r is number => r !== null), 0.5), recorded: withRecord.length };
}

// ---- Grouping

export interface Bucket {
  key: string;
  /** The issue an Issue row is; null for the row of pull requests naming none. */
  issue: number | null;
  pulls: Pull[];
  sortKey: number | string;
}

/** The rows of a tab, newest first: a day, a pull request, an issue or a size. */
export function buckets(group: Exclude<Group, 'check'>, list: Pull[], issueOf: (p: Pull) => number | null): Bucket[] {
  const map = new Map<string, Bucket>();
  for (const p of list) {
    let key: string;
    let sortKey: number | string;
    let issue: number | null = null;
    if (group === 'day') {
      key = belgianDay(mergedMs(p));
      sortKey = key;
    } else if (group === 'size') {
      const s = sizeOf(p);
      key = s.key;
      sortKey = -SIZES.indexOf(s);
    } else if (group === 'issue') {
      issue = issueOf(p);
      key = issue === null ? 'none' : String(issue);
      sortKey = issue === null ? -1 : mergedMs(p);
    } else {
      key = String(p.number);
      sortKey = mergedMs(p);
    }
    const b = map.get(key) ?? { key, issue, pulls: [], sortKey };
    b.pulls.push(p);
    if (group === 'issue' && issue !== null && typeof b.sortKey === 'number') b.sortKey = Math.max(b.sortKey, mergedMs(p));
    map.set(key, b);
  }
  return [...map.values()].sort((a, b) => (a.sortKey < b.sortKey ? 1 : a.sortKey > b.sortKey ? -1 : 0));
}

// ---- Checks

export interface CheckRow {
  name: string;
  /** Rounds it was among the checks that held, and how many it finished last. */
  held: number;
  last: number;
  ms: number;
  median: number | null;
  red: number;
  redPulls: number[];
  flukes: number;
  /** Null where no wait for a runner was recorded for it. */
  queue: number | null;
}

/** Which check held the rounds up: per check, the rounds it held, the ones it finished last, its minutes and what went wrong in it. Most minutes first. */
export function checkRows(list: Pull[]): { rows: CheckRow[]; rounds: number; names: string[] } {
  const rounds = list.flatMap((p) => p.rounds.map((r) => ({ p, r })));
  const names = [...CHECKS];
  for (const { r } of rounds) for (const c of r.checks) if (!names.includes(c.name)) names.push(c.name);
  const rows = names
    .map((name): CheckRow => {
      const held = rounds.filter(({ r }) => r.checks.some((c) => c.name === name));
      const heldMs = held.map(({ r }) => sum(r.checks.filter((c) => c.name === name).map((c) => c.heldMs)));
      const red = rounds.filter(({ r }) => r.red && r.failed.includes(name));
      return {
        name,
        held: held.length,
        last: rounds.filter(({ r }) => r.last === name).length,
        ms: sum(heldMs),
        median: quantile(heldMs, 0.5),
        red: red.length,
        redPulls: [...new Set(red.map(({ p }) => p.number))],
        flukes: rounds.filter(({ r }) => r.checks.some((c) => c.name === name && c.flukeMs !== null)).length,
        queue: quantile(rounds.flatMap(({ r }) => r.checks.filter((c) => c.name === name && c.queuedMs !== null).map((c) => c.queuedMs!)), 0.5),
      };
    })
    .filter((r) => r.held > 0 || r.red > 0 || r.flukes > 0)
    .sort((a, b) => b.ms - a.ms);
  return { rows, rounds: rounds.length, names };
}

// ---- Loading

/** Everything the page draws, read in one round trip: the period and the one before it, so the tile can compare. */
export function loadCycleTime(db: D1Database, q: CycleTimeQuery, now: number): Promise<CycleTimeView> {
  const days = PERIODS[q.period];
  return cycleTimeView(db, days === null ? 0 : startOfDay(addDays(belgianDay(now), -(2 * days - 1))));
}
