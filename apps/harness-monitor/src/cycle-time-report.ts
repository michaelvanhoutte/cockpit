import { addDays, belgianDay, startOfDay } from './belgium';
import type { LocalKind } from './cycle-time';
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
/** The period as a word of the page's sentence ("merged in the last 7 days"). */
export const PERIOD_CHOICES: [Period, string][] = [['3d', 'in the last 3 days'], ['7d', 'in the last 7 days'], ['all', 'at any time held']];

export const GROUPS = ['day', 'pr', 'issue', 'size', 'check'] as const;
export type Group = (typeof GROUPS)[number];
export const GROUP_LABELS: Record<Group, string> = { day: 'Over time', pr: 'Pull request', issue: 'Issue', size: 'Size', check: 'Check' };

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
}

const DEFAULTS: CycleTimeQuery = { period: 'all', size: null, outcome: null, group: 'day' };

/** The view the address asks for; anything unrecognised, including a `split` an old link carries, is left out and falls back to the default. */
export function parseCycleTimeQuery(params: URLSearchParams): CycleTimeQuery {
  const size = params.get('size');
  const outcome = params.get('outcome');
  const group = GROUPS.find((g) => g === params.get('group')) ?? DEFAULTS.group;
  return {
    period: (Object.keys(PERIODS) as Period[]).find((p) => p === params.get('period')) ?? DEFAULTS.period,
    // A filter that repeats the rows is dropped, as its control is not offered.
    size: group !== 'size' && size !== null && SIZES.some((s) => s.key === size) ? size : null,
    outcome: outcome !== null && outcome !== '' && OUTCOMES.some(([v]) => v === outcome) ? outcome : null,
    group,
  };
}

/** The address of a view: a query with some of it changed. Defaults are left out, so one view has one address (and one cache entry). */
export function cycleTimeAddress(q: CycleTimeQuery, over: Partial<CycleTimeQuery> = {}): string {
  const all = { ...q, ...over };
  const params = new URLSearchParams();
  for (const key of ['period', 'size', 'outcome', 'group'] as const) if (all[key] !== DEFAULTS[key]) params.set(key, String(all[key]));
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

/** The checks CI runs today, which the outline and the Check tab name; any other a round held is drawn together as Other checks. */
export const CHECKS = ['E2E (F3)', 'Test', 'Checks', 'Test Explorer', 'Contract tests'];

/** The five phases of a pull request, in stacking order: its key and its name. `away` is the grey one. */
export const PHASES: { key: PhaseKey; label: string; other?: boolean }[] = [
  { key: 'writing', label: 'Writing' },
  { key: 'local', label: 'Local checks' },
  { key: 'ci', label: 'CI rounds' },
  { key: 'waiting', label: 'Waiting to merge' },
  { key: 'away', label: 'Away', other: true },
];
export type PhaseKey = 'writing' | 'local' | 'ci' | 'waiting' | 'away';

/** The four kinds of local check the session record names, in the order they are drawn. */
const LOCAL_PARTS: { key: LocalKind; label: string }[] = [
  { key: 'code-review', label: 'Code review' },
  { key: 'security-review', label: 'Security review' },
  { key: 'test', label: 'Test runs' },
  { key: 'browser', label: 'Browser pass' },
];

/** Each pull request's phases, worked out once: a page asks for them once per phase. */
const VALUES = new WeakMap<Pull, Record<PhaseKey, number | null>>();

/**
 * A pull request's minutes per phase; null where its session record holds none,
 * which is not zero. The five phases add up to start to merge: a pull request
 * with no record has its writing and its local checks as one figure, the time
 * that is left.
 */
export function values(p: Pull): Record<PhaseKey, number | null> {
  const kept = VALUES.get(p);
  if (kept) return kept;
  const waiting = p.time.waitingToMergeMs ?? 0;
  const made = {
    writing: p.time.codingMs ?? Math.max(0, p.time.totalMs - p.time.ciMs - waiting - p.time.awayMs),
    local: p.time.localMs,
    ci: p.time.ciMs,
    waiting,
    away: p.time.awayMs,
  };
  VALUES.set(p, made);
  return made;
}

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

// ---- The outline

/**
 * One row of the outline: a phase, or a part of one. `left` and `width` are
 * shares of start to merge, so every bar sits on the one scale.
 */
export interface OutlineRow {
  key: string;
  label: string;
  /** A phase's time waited, or a part's time spent, which is null where it is not recorded. */
  ms: number | null;
  /** A phase's share of start to merge, or a part's of its phase's time spent: 0 to 1; null for a part with no time spent recorded, or in a phase whose is not. */
  share: number | null;
  left: number;
  /** A part's is its own length, cut where the scale ends; 0 where not recorded. */
  width: number;
  /** A phase that opens into parts: the time spent they add up to, null where one of them is not recorded. Null for a phase without parts and for a part. */
  spent: { ms: number | null; overlap: boolean } | null;
  /** The phase a part belongs to; a phase is its own. */
  phase: PhaseKey;
  part: boolean;
  /** Drawn grey: time with no phase colour of its own, or a part that is not one of the named ones. */
  other: boolean;
  /** Where the phase's own stretch lies, for a part's band behind its bar. */
  stretch: { left: number; width: number } | null;
}

export interface Outline {
  /** Start to merge over the list: the phases added up. */
  total: number;
  rows: OutlineRow[];
  /** Pull requests whose local checks are not split by kind. */
  unsplit: number;
  /** Pull requests with a check attempt whose running time is not recorded. */
  noRunning: number;
}

/** A row the outline can have, in the order it is drawn: each phase, then the parts it opens into. */
export interface OutlineSlot {
  key: string;
  label: string;
  phase: PhaseKey;
  part: boolean;
  /** Drawn grey: a phase with no colour of its own, or a part that is not one of the named ones. */
  other: boolean;
}

/** Every row an outline can have, so a row's figures are one number per slot, in this order. */
export const OUTLINE_SLOTS: OutlineSlot[] = PHASES.flatMap((ph): OutlineSlot[] => {
  const phase: OutlineSlot = { key: ph.key, label: ph.label, phase: ph.key, part: false, other: ph.other === true };
  const part = (key: string, label: string, other = false): OutlineSlot => ({ key, label, phase: ph.key, part: true, other });
  if (ph.key === 'local') return [phase, ...LOCAL_PARTS.map((k) => part(k.key, k.label)), part('not-split', 'Not split by kind', true)];
  if (ph.key === 'ci') return [phase, ...CHECKS.map((name) => part(`check:${name}`, name)), part('other-checks', 'Other checks', true)];
  return [phase];
});

/**
 * Whether a pull request's local checks are split by kind. Reviews recorded
 * without a per-kind split are not; no reviews recorded is, with both review
 * kinds at 0, and its test runs and browser pass still come from `localRuns`.
 */
export const splitByKind = (p: Pull) => p.localReviews === null || p.localReviews.byKind !== null;

/** A local kind's own minutes as the session recorded them: two kinds at once are each counted in full. */
function kindMs(p: Pull, kind: LocalKind): number {
  if (kind === 'test' || kind === 'browser') return p.localRuns[kind]?.ms ?? 0;
  return p.localReviews?.byKind?.[kind].ms ?? 0;
}

/**
 * The figure of every slot over `list`, divided by `per` where a row is a pull
 * request on average. A phase is the pull requests' time waited added up. A
 * part is time spent: a local kind's own minutes, a CI check's attempts'
 * running time added up, and for a pull request with no kinds stored its local
 * minutes in Not split by kind. A CI part with any attempt whose running time
 * is not recorded is null, never the sum of the rest.
 */
export function outlineFigures(list: Pull[], per = 1): (number | null)[] {
  const known = new Set(CHECKS);
  const figure = (s: OutlineSlot): number | null => {
    if (!s.part) return sum(list.map((p) => values(p)[s.phase] ?? 0));
    if (s.key === 'not-split') return sum(list.filter((p) => !splitByKind(p)).map((p) => p.time.localMs ?? 0));
    if (s.phase === 'local') return sum(list.filter(splitByKind).map((p) => kindMs(p, s.key as LocalKind)));
    const attempts = list.flatMap((p) => p.rounds.flatMap((r) => r.checks.filter((c) => (s.key === 'other-checks' ? !known.has(c.name) : `check:${c.name}` === s.key))));
    return attempts.some((c) => c.runningMs === null) ? null : sum(attempts.map((c) => c.runningMs!));
  };
  return OUTLINE_SLOTS.map((s) => {
    const ms = figure(s);
    return ms === null ? null : ms / per;
  });
}

/**
 * Lays figures out as one start-to-merge scale. Phases are time waited, end to
 * end, and add up to start to merge. A phase's parts are time spent: each bar
 * starts where its phase starts, at its own length on the same scale, cut where
 * the scale ends, so one that ran longer than the phase waited runs past the
 * phase's end, which the row's `stretch` marks. A phase's share is of start to
 * merge; a part's is of its phase's time spent. A slot with no minutes is left
 * out, and a phase left out takes its parts with it; a part not recorded stays,
 * with no bar, and leaves its phase's time spent and its shares not recorded.
 * The strip a table row opens runs the same arithmetic in the browser
 * (STRIP_LAYOUT_SOURCE), which a unit test holds to this.
 */
export function layOut(figures: (number | null)[]): { total: number; rows: OutlineRow[] } {
  const total = sum(OUTLINE_SLOTS.flatMap((s, i) => (s.part ? [] : [figures[i]!])));
  const scale = (ms: number) => (total ? ms / total : 0);
  // What each phase's parts add up to; null where one is not recorded, and absent for a phase with none.
  const spent = new Map<PhaseKey, number | null>();
  OUTLINE_SLOTS.forEach((s, i) => {
    const ms = figures[i] ?? null;
    if (!s.part || (ms !== null && ms <= 0)) return;
    const before = spent.get(s.phase);
    spent.set(s.phase, ms === null || before === null ? null : (before ?? 0) + ms);
  });
  const rows: OutlineRow[] = [];
  let at = 0;
  let stretch: { left: number; width: number } | null = null;
  OUTLINE_SLOTS.forEach((s, i) => {
    const ms = figures[i] ?? null;
    if (!s.part) {
      stretch = ms! > 0 ? { left: scale(at), width: scale(ms!) } : null;
      if (stretch === null) return;
      const all = spent.get(s.phase);
      const mine = all === undefined ? null : { ms: all, overlap: all !== null && all > ms! };
      rows.push({ key: s.key, label: s.label, ms, share: scale(ms!), left: stretch.left, width: stretch.width, spent: mine, phase: s.phase, part: false, other: s.other, stretch: null });
      at += ms!;
    } else if (stretch !== null && (ms === null || ms > 0)) {
      const all = spent.get(s.phase) ?? null;
      const { left, width } = stretch as { left: number; width: number };
      rows.push({
        key: s.key,
        label: s.label,
        ms,
        share: ms === null || !all ? null : ms / all,
        left,
        width: ms === null ? 0 : Math.min(scale(ms), 1 - left),
        spent: null,
        phase: s.phase,
        part: true,
        other: s.other,
        stretch,
      });
    }
  });
  return { total, rows };
}

/**
 * What a row says: the line under a phase's name naming its time spent, and its
 * amount, a phase's as time waited where it has parts and a part's as time
 * spent. The strip's script has the same words (`words`), which a unit test
 * holds to these.
 */
export function words(r: OutlineRow): { spent: string | null; amount: string } {
  const spent = r.spent === null ? null : r.spent.ms === null ? 'time spent not recorded' : `${hm(r.spent.ms)} spent${r.spent.overlap ? ' side by side' : ''}`;
  if (r.part) return { spent, amount: r.ms === null ? 'not recorded' : `${hm(r.ms)} spent` };
  return { spent, amount: r.spent === null ? hm(r.ms!) : `${hm(r.ms!)} waited` };
}

/**
 * Where the time went, as one outline: every phase on one start-to-merge scale
 * as time waited, Local checks opened into its four kinds and CI rounds into
 * its checks as time spent. A row with no minutes is left out.
 */
export function outline(list: Pull[]): Outline {
  return {
    ...layOut(outlineFigures(list)),
    unsplit: list.filter((p) => !splitByKind(p) && (p.time.localMs ?? 0) > 0).length,
    noRunning: list.filter((p) => p.rounds.some((r) => r.checks.some((c) => c.runningMs === null))).length,
  };
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
