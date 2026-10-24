import { addDays, belgianDay, startOfDay } from './belgium';
import { quantile } from './cycle-time-report';
import { number } from './page';
import { leadingRule, type JobFilter, verdictOf } from './selection-store';
import type { BarId, SelectionJob } from './selection';
import type { PackageRun, StoredBar, ViewJob, ViewPull, ViewWants } from './selection-view';

/**
 * What the test selection page works out of the stored rows: the view an
 * address asks for, how each job's pull requests are counted, which rule forced
 * the most full runs, and how the rows of each tab are grouped. The queries only
 * gather (selection-view.ts); every figure the page draws is worked out here.
 */

export type Job = SelectionJob;
export const JOB_NAMES: Record<Job, string> = { test: 'Test job', e2e: 'E2E job' };
/** What a job's files are called: a test file, or a spec. */
export const UNIT: Record<Job, [string, string]> = { test: ['test file', 'test files'], e2e: ['spec', 'specs'] };

export const GROUPS = ['day', 'pr', 'rule', 'package', 'test', 'miss'] as const;
export type Group = (typeof GROUPS)[number];
export const GROUP_LABELS: Record<Group, string> = { day: 'Overview', pr: 'Pull request', rule: 'What forced a full run', package: 'Package', test: 'Most selected tests', miss: 'Misses' };

/** The Period filter, in days; `all` is every pull request held, which reaches about 90 days. */
export const PERIODS = { '7d': 7, '14d': 14, all: null } as const;
export type Period = keyof typeof PERIODS;
export const PERIOD_CHOICES: [Period, string][] = [['7d', 'Last 7 days'], ['14d', 'Last 14 days'], ['all', 'Everything held']];
export const DEFAULT_PERIOD: Period = '14d';

export const JOB_CHOICES: [JobFilter, string][] = [['both', 'Both'], ['test', 'Test job'], ['e2e', 'E2E job']];

export const OUTCOME_FILTERS = ['selected', 'full', 'miss', 'docs'] as const;
export type OutcomeFilter = (typeof OUTCOME_FILTERS)[number];
export const OUTCOME_CHOICES: [string, string][] = [
  ['', 'Every pull request'],
  ['selected', 'Selected a subset'],
  ['full', 'Ran everything'],
  ['miss', 'With a miss'],
  ['docs', 'Documentation only'],
];

export type Outcome = 'selected' | 'full' | 'docs' | 'none';
export const OUTCOME_LABELS: Record<Outcome, string> = { selected: 'Selected a subset', full: 'Ran everything', docs: 'Skipped: documentation only', none: 'No record' };
export const OUTCOMES: Outcome[] = ['selected', 'full', 'docs', 'none'];

/** The most test files the Most selected tests tab lists. */
export const TEST_ROWS = 50;

export interface SelectionQuery {
  group: Group;
  period: Period;
  job: JobFilter;
  outcome: OutcomeFilter | null;
  /** The drill-downs: one pull request, one rule (`job:rule`), one test. Each belongs to its own tab. */
  pr: number | null;
  rule: string | null;
  test: string | null;
}

const DEFAULTS = { group: 'day', period: DEFAULT_PERIOD, job: 'both' } as const;

/** The view the address asks for; anything unrecognised falls back to the default, and a drill-down only counts on its own tab. */
export function parseSelectionQuery(params: URLSearchParams): SelectionQuery {
  const group = GROUPS.find((g) => g === params.get('group')) ?? DEFAULTS.group;
  const pr = Number(params.get('pr'));
  return {
    group,
    period: (Object.keys(PERIODS) as Period[]).find((p) => p === params.get('period')) ?? DEFAULTS.period,
    job: JOB_CHOICES.find(([v]) => v === params.get('job'))?.[0] ?? DEFAULTS.job,
    outcome: group === 'pr' ? (OUTCOME_FILTERS.find((o) => o === params.get('outcome')) ?? null) : null,
    pr: group === 'pr' && Number.isInteger(pr) && pr > 0 ? pr : null,
    rule: group === 'rule' ? params.get('rule') || null : null,
    test: group === 'test' ? params.get('test') || null : null,
  };
}

/** The address of a view: a query with some of it changed. A drill-down is dropped unless `over` names it, and defaults are left out, so one view has one address (and one cache entry). */
export function selectionAddress(q: SelectionQuery, over: Partial<SelectionQuery> = {}): string {
  const all = { ...q, pr: null, rule: null, test: null, ...over };
  const params = new URLSearchParams();
  if (all.group !== DEFAULTS.group) params.set('group', all.group);
  if (all.period !== DEFAULTS.period) params.set('period', all.period);
  if (all.job !== DEFAULTS.job) params.set('job', all.job);
  if (all.group === 'pr' && all.outcome !== null) params.set('outcome', all.outcome);
  if (all.group === 'pr' && all.pr !== null) params.set('pr', String(all.pr));
  if (all.group === 'rule' && all.rule !== null) params.set('rule', all.rule);
  if (all.group === 'test' && all.test !== null) params.set('test', all.test);
  const text = params.toString();
  return text === '' ? '/selection' : `/selection?${text}`;
}

/** The start of the period's first Belgian day, in epoch milliseconds; 0 for every pull request held. */
export function periodStart(period: Period, now: number): number {
  const days = PERIODS[period];
  return days === null ? 0 : startOfDay(addDays(belgianDay(now), -(days - 1)));
}

/** What the tab needs read: each asks for its own rows, so a tab never pays for another's. */
export function wantsOf(q: SelectionQuery): ViewWants {
  const none: ViewWants = { pulls: false, reasons: false, misses: false, tally: null, packages: false, pull: null, test: null };
  if (q.group === 'day') return { ...none, pulls: true, reasons: true, misses: true, tally: 0 };
  if (q.group === 'pr') return q.pr !== null ? { ...none, pull: q.pr } : { ...none, pulls: true, reasons: true, misses: true };
  if (q.group === 'rule') return { ...none, pulls: true, reasons: true };
  if (q.group === 'package') return { ...none, pulls: true, packages: true };
  if (q.group === 'test') return q.test !== null ? { ...none, test: q.test } : { ...none, pulls: true, tally: TEST_ROWS };
  return { ...none, pulls: true, misses: true };
}

// ---- Reading

export { plural } from './cycle-time-report';
export const percent = (value: number) => `${Math.round(value * 100)}%`;

/** The middle value, the middle pair averaged on an even count; null for none. */
export const median = (values: number[]) => quantile(values, 0.5);

/** The bars' numbers as the last send carried them; the tool's own values stand in for one never sent. */
export interface Bars {
  minPulls: number;
  forcedFull: Record<Job, number>;
  misses: number;
  mostShare: number;
  mostMinOver: number;
  alarm: Record<BarId, number | null>;
}

export function barsOf(stored: StoredBar[]): Bars {
  const bar = (id: BarId) => stored.find((each) => each.id === id);
  return {
    minPulls: stored[0]?.minPulls ?? 20,
    forcedFull: { test: bar('test-forced-full')?.threshold ?? 0.25, e2e: bar('e2e-forced-full')?.threshold ?? 0.25 },
    misses: bar('misses')?.threshold ?? 1,
    mostShare: bar('most-selected')?.threshold ?? 0.8,
    mostMinOver: bar('most-selected')?.minOver ?? 10,
    alarm: {
      'e2e-forced-full': bar('e2e-forced-full')?.alarmIssue ?? null,
      'test-forced-full': bar('test-forced-full')?.alarmIssue ?? null,
      misses: bar('misses')?.alarmIssue ?? null,
      'most-selected': bar('most-selected')?.alarmIssue ?? null,
    },
  };
}

export { verdictOf };
export type Verdict = ReturnType<typeof verdictOf>;
export const tileClass = (verdict: Verdict) => (verdict === 'crossed' ? 'up' : verdict === 'within' ? 'down' : '');

/** A job that left no record of a pull request: counted in neither direction. */
const NO_RECORD: ViewJob = { status: 'no-record', ranEverything: false, selecting: false, filesRun: null, filesTotal: null, prDurationMs: null, mainDurationMs: null, unplacedFiles: null, reasons: [], misses: [] };
export const jobOf = (p: ViewPull, job: Job): ViewJob => p.jobs[job] ?? NO_RECORD;

export const outcomeOf = (v: ViewJob): Outcome => (v.status === 'ran' ? (v.ranEverything ? 'full' : 'selected') : v.status === 'docs-only' ? 'docs' : 'none');
export const dayOf = (p: ViewPull) => belgianDay(p.mergedAt);
export const missesOf = (p: ViewPull, jobs: Job[]) => jobs.reduce((n, job) => n + jobOf(p, job).misses.length, 0);

/** A job is over the bar for the period when it ran everything on a quarter or more of the pull requests that ran it, and the period holds enough to read. */
export function overBar(pulls: ViewPull[], job: Job, bars: Bars): boolean {
  const ran = pulls.map((p) => jobOf(p, job)).filter((v) => v.status === 'ran');
  return pulls.length >= bars.minPulls && ran.length > 0 && verdictOf(true, ran.filter((v) => v.ranEverything).length / ran.length, bars.forcedFull[job]) === 'crossed';
}

/** Of the pull requests that ran everything, the rule that forced the most of them. */
export const leadingRuleOf = (full: ViewJob[]) => leadingRule(full.map((v) => v.reasons.map((r) => r.rule)));

/** The share of the pull requests that could have skipped a file which selected it. */
export const shareOf = (row: { selected: number; selecting: number }) => (row.selecting > 0 ? row.selected / row.selecting : 0);

/** A selection in words as the page reads it: an import chain without the test itself at its head, behind "via". */
export function whyText(text: string | null, path: string): string {
  if (!text) return 'selected by Vitest; no import chain found';
  const words = text.replaceAll('`', '');
  if (words === path) return 'itself changed';
  const head = `${path} → `;
  return words.startsWith(head) ? `via ${words.slice(head.length)}` : words;
}

/** The days the overview charts and lists: from the period's first, or the oldest pull request held where that is later, to today. */
export function dayRange(period: Period, oldest: number | null, now: number): string[] {
  const days = PERIODS[period];
  const today = belgianDay(now);
  const asked = days === null ? null : addDays(today, -(days - 1));
  const held = oldest === null ? null : belgianDay(oldest);
  const first = asked === null ? (held ?? today) : held !== null && held > asked ? held : asked;
  const range: string[] = [];
  for (let d = first; d <= today; d = addDays(d, 1)) range.push(d);
  return range;
}

// ---- Grouping

export interface RuleRow {
  job: Job;
  rule: string;
  pulls: Map<number, ViewPull>;
  /** The pull requests the rule left running everything. */
  everything: Set<number>;
  /** Each path that forced it, with the pull requests it forced. */
  paths: Map<string, ViewPull[]>;
  /** The pull requests the job ran in the period. */
  of: number;
}

/** A row per rule and job, worst first: the pull requests it forced a package on, counted once per rule. */
export function ruleRows(pulls: ViewPull[], jobs: Job[]): RuleRow[] {
  const rows: RuleRow[] = [];
  for (const job of jobs) {
    const ran = pulls.filter((p) => jobOf(p, job).status === 'ran');
    const byRule = new Map<string, RuleRow>();
    for (const p of ran) {
      const v = jobOf(p, job);
      for (const r of v.reasons) {
        const row = byRule.get(r.rule) ?? { job, rule: r.rule, pulls: new Map(), everything: new Set(), paths: new Map(), of: ran.length };
        byRule.set(r.rule, row);
        row.pulls.set(p.number, p);
        if (v.ranEverything) row.everything.add(p.number);
        const key = r.path ?? '(no path)';
        const list = row.paths.get(key) ?? [];
        if (!list.includes(p)) list.push(p);
        row.paths.set(key, list);
      }
    }
    rows.push(...byRule.values());
  }
  return rows.sort((a, b) => b.pulls.size - a.pulls.size || a.job.localeCompare(b.job) || a.rule.localeCompare(b.rule));
}

export interface PackageSummary {
  job: Job;
  name: string;
  /** Most test files any pull request found in it; null where none sent a total. */
  files: number | null;
  /** The pull requests it selected on, and those on which something of it ran. */
  changed: number;
  touched: number;
  runs: number[];
  full: number;
  reasons: Map<string, number>;
}

/** A row per package (every E2E spec as one), the most often touched first. */
export function packageRows(runs: PackageRun[]): PackageSummary[] {
  const map = new Map<string, PackageSummary>();
  for (const run of runs) {
    const name = run.job === 'e2e' ? 'Every E2E spec' : run.name;
    const row = map.get(`${run.job}:${name}`) ?? { job: run.job, name, files: null as number | null, changed: 0, touched: 0, runs: [], full: 0, reasons: new Map<string, number>() };
    map.set(`${run.job}:${name}`, row);
    if (run.filesTotal !== null) row.files = Math.max(row.files ?? 0, run.filesTotal);
    if (run.mode === 'full') {
      row.full++;
      if (run.rule) row.reasons.set(run.rule, (row.reasons.get(run.rule) ?? 0) + 1);
      continue;
    }
    // A package that wrote no report says nothing of what it ran, so it is neither a selection nor a miss of one.
    if (run.report === 'none') continue;
    row.changed++;
    if (run.ran > 0) {
      row.touched++;
      row.runs.push(run.ran);
    }
  }
  return [...map.values()].sort((a, b) => (b.changed ? b.touched / b.changed : 0) - (a.changed ? a.touched / a.changed : 0) || b.full - a.full);
}

export const jobsOf = (job: JobFilter): Job[] => (job === 'both' ? ['test', 'e2e'] : [job]);

/** The pull requests the Pull request tab lists for an outcome filter. */
export function matchesOutcome(p: ViewPull, jobs: Job[], outcome: OutcomeFilter | null): boolean {
  if (outcome === null) return true;
  if (outcome === 'docs') return jobs.length > 0 && jobs.every((j) => jobOf(p, j).status === 'docs-only');
  if (outcome === 'miss') return missesOf(p, jobs) > 0;
  return jobs.some((j) => outcomeOf(jobOf(p, j)) === outcome);
}
