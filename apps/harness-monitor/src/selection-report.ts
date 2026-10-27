import { addDays, belgianDay, formatDateTime, formatDay, startOfDay } from './belgium';
import { plural, quantile } from './cycle-time-report';
import { humanMs } from './report';
import { type CheckMs, checkKey, type JobFilter, verdictOf } from './selection-store';
import type { SelectionJob } from './selection';
import type { StoredBar, ViewJob, ViewPull, ViewWants } from './selection-view';

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

/** The rows the sentence offers. */
export const ROWS = ['day', 'rule', 'miss'] as const;
/** The views an address can open: the rows, and one pull request's whole selection, which only a link opens. */
export const GROUPS = [...ROWS, 'pr'] as const;
export type Group = (typeof GROUPS)[number];

/** The Period choice, in days; `all` is every pull request held, which reaches about 90 days. */
export const PERIODS = { '7d': 7, '14d': 14, all: null } as const;
export type Period = keyof typeof PERIODS;
/** The period as a word of the page's sentence ("over the last 14 days"). */
export const PERIOD_CHOICES: [Period, string][] = [['7d', 'the last 7 days'], ['14d', 'the last 14 days'], ['all', 'everything held']];
export const DEFAULT_PERIOD: Period = '14d';

/** The job as a word of the page's sentence ("in the E2E job"). */
export const JOB_CHOICES: [JobFilter, string][] = [['both', 'both jobs'], ['test', 'the Test job'], ['e2e', 'the E2E job']];

export type Outcome = 'selected' | 'full' | 'docs' | 'none';
export const OUTCOME_LABELS: Record<Outcome, string> = { selected: 'Selected a subset', full: 'Ran everything', docs: 'Skipped: documentation only', none: 'No record' };
export const OUTCOMES: Outcome[] = ['selected', 'full', 'docs', 'none'];

export interface SelectionQuery {
  group: Group;
  period: Period;
  job: JobFilter;
  /** The drill-downs: one pull request, one rule (`job:rule`). Each belongs to its own view. */
  pr: number | null;
  rule: string | null;
}

const DEFAULTS = { group: 'day', period: DEFAULT_PERIOD, job: 'both' } as const;

/** The view the address asks for; anything the sentence does not offer falls back to each day, as does one pull request's view without a pull request, and a drill-down only counts on its own view. */
export function parseSelectionQuery(params: URLSearchParams): SelectionQuery {
  const asked = GROUPS.find((g) => g === params.get('group')) ?? DEFAULTS.group;
  const raw = Number(params.get('pr'));
  const pr = Number.isInteger(raw) && raw > 0 ? raw : null;
  const group = asked === 'pr' && pr === null ? DEFAULTS.group : asked;
  return {
    group,
    period: (Object.keys(PERIODS) as Period[]).find((p) => p === params.get('period')) ?? DEFAULTS.period,
    job: JOB_CHOICES.find(([v]) => v === params.get('job'))?.[0] ?? DEFAULTS.job,
    pr: group === 'pr' ? pr : null,
    rule: group === 'rule' ? params.get('rule') || null : null,
  };
}

/** The address of a view: a query with some of it changed. A drill-down is dropped unless `over` names it, and defaults are left out, so one view has one address (and one cache entry). */
export function selectionAddress(q: SelectionQuery, over: Partial<SelectionQuery> = {}): string {
  const all = { ...q, pr: null, rule: null, ...over };
  const params = new URLSearchParams();
  if (all.group !== DEFAULTS.group) params.set('group', all.group);
  if (all.period !== DEFAULTS.period) params.set('period', all.period);
  if (all.job !== DEFAULTS.job) params.set('job', all.job);
  if (all.group === 'pr' && all.pr !== null) params.set('pr', String(all.pr));
  if (all.group === 'rule' && all.rule !== null) params.set('rule', all.rule);
  const text = params.toString();
  return text === '' ? '/selection' : `/selection?${text}`;
}

/** The start of the period's first Belgian day, in epoch milliseconds; 0 for every pull request held. */
export function periodStart(period: Period, now: number): number {
  const days = PERIODS[period];
  return days === null ? 0 : startOfDay(addDays(belgianDay(now), -(days - 1)));
}

/** What the view needs read: each asks for its own rows, so a view never pays for another's. */
export function wantsOf(q: SelectionQuery): ViewWants {
  const none: ViewWants = { pulls: false, reasons: false, misses: false, checks: false, pull: null };
  if (q.group === 'day') return { ...none, pulls: true, reasons: true, misses: true, checks: true };
  if (q.group === 'pr') return { ...none, pull: q.pr };
  if (q.group === 'rule') return q.rule ? { ...none, pulls: true, reasons: true } : { ...none, pulls: true, reasons: true, checks: true };
  return { ...none, pulls: true, misses: true };
}

// ---- Reading

export { plural };
export const percent = (value: number) => `${Math.round(value * 100)}%`;

/** The middle value, the middle pair averaged on an even count; null for none. */
export const median = (values: number[]) => quantile(values, 0.5);

/** The bars' numbers as the last send carried them; the tool's own values stand in for one never sent. */
export interface Bars {
  minPulls: number;
  forcedFull: Record<Job, number>;
}

export function barsOf(stored: StoredBar[]): Bars {
  const bar = (id: StoredBar['id']) => stored.find((each) => each.id === id);
  return {
    minPulls: stored[0]?.minPulls ?? 20,
    forcedFull: { test: bar('test-forced-full')?.threshold ?? 0.25, e2e: bar('e2e-forced-full')?.threshold ?? 0.25 },
  };
}

export { verdictOf };

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

/** A selection in words as the page reads it: an import chain without the test itself at its head, behind "via". */
export function whyText(text: string | null, path: string): string {
  if (!text) return 'selected by Vitest; no import chain found';
  const words = text.replaceAll('`', '');
  if (words === path) return 'itself changed';
  const head = `${path} → `;
  return words.startsWith(head) ? `via ${words.slice(head.length)}` : words;
}

/** A file a check selected, as the read returns it. */
export interface SelectedFile {
  package: string;
  path: string;
  status: 'passed' | 'failed';
  text: string | null;
}

/** The files that share the changed file their chain started from. */
export interface StartGroup {
  /** `file`: a changed file (or, for a spec, the area's own words); `itself`: the test files that changed themselves; `none`: no chain text was stored. */
  kind: 'file' | 'itself' | 'none';
  /** The changed file, or the words of the group. */
  label: string;
  files: SelectedFile[];
  /** How many of its files each package ran, most first. */
  byPackage: [string, number][];
  /** The step most of the group's chains take just before the changed file, where it carries half of a group of five or more. */
  through: { step: string; count: number } | null;
}

/** A group needs this many files before one step in front of the changed file can be said to carry them. */
const THROUGH_MIN_FILES = 5;

/**
 * The files a check selected, grouped by the changed file each file's chain
 * started from, largest group first and equal groups by their words. A file is
 * counted under the one chain the record holds for it.
 */
export function groupByStart(files: SelectedFile[]): StartGroup[] {
  const stepsOf = (f: SelectedFile) => (f.text ?? '').replaceAll('`', '').split(' → ');
  const startOf = (f: SelectedFile): Pick<StartGroup, 'kind' | 'label'> => {
    if (!f.text) return { kind: 'none', label: 'no import chain found' };
    const words = f.text.replaceAll('`', '');
    if (words === f.path || words === 'itself changed') return { kind: 'itself', label: 'The test files that changed themselves' };
    const steps = stepsOf(f);
    return { kind: 'file', label: steps.length > 1 ? steps.at(-1)! : words };
  };
  const groups = new Map<string, StartGroup>();
  for (const f of files) {
    const start = startOf(f);
    const key = `${start.kind}:${start.label}`;
    const group = groups.get(key) ?? { ...start, files: [], byPackage: [], through: null };
    groups.set(key, group);
    group.files.push(f);
  }
  for (const group of groups.values()) {
    const packages = new Map<string, number>();
    const before = new Map<string, number>();
    for (const f of group.files) {
      packages.set(f.package, (packages.get(f.package) ?? 0) + 1);
      const steps = stepsOf(f);
      if (group.kind === 'file' && steps.length > 2) before.set(steps.at(-2)!, (before.get(steps.at(-2)!) ?? 0) + 1);
    }
    group.byPackage = [...packages.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const hub = [...before.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    if (hub && group.files.length >= THROUGH_MIN_FILES && hub[1] / group.files.length >= 0.5) group.through = { step: hub[0], count: hub[1] };
  }
  return [...groups.values()].sort((a, b) => b.files.length - a.files.length || a.label.localeCompare(b.label));
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

/** A rule that forced none of its job's latest this many pull requests that ran it reads as stopped. */
export const STOPPED_AFTER_PULLS = 20;

/** The three groups the rules sit in, in the order the page lists them. */
export const RULE_GROUPS = ['fix', 'expected', 'stopped'] as const;
export type RuleGroup = (typeof RULE_GROUPS)[number];
export const RULE_GROUP_LABELS: Record<RuleGroup, string> = {
  fix: 'Rules to fix',
  expected: 'Expected: they force a full run by design',
  stopped: `Stopped: none of the last ${STOPPED_AFTER_PULLS} pull requests`,
};

/**
 * The median time a job's check held a pull request up where it selected: what
 * a run of the job costs when no rule forces everything. Null where the period
 * holds no selected run with a check time, which is no figure, never zero.
 */
export function typicalSelectedMs(pulls: ViewPull[], job: Job, checkMs: CheckMs): number | null {
  return median(
    pulls
      .filter((p) => outcomeOf(jobOf(p, job)) === 'selected')
      .map((p) => checkMs.get(checkKey(job, p.number)))
      .filter((ms): ms is number => ms !== undefined),
  );
}

/**
 * What full runs of a job could have saved: each one's time in its check, less
 * a typical selected run, never below zero for one run, and a pull request
 * cycle time does not hold counting nothing. Null where there is no typical
 * selected run to measure against.
 */
function totalSaved(job: Job, runs: Iterable<number>, typical: number | null, checkMs: CheckMs): number | null {
  if (typical === null) return null;
  let saved = 0;
  for (const n of runs) saved += Math.max(0, (checkMs.get(checkKey(job, n)) ?? 0) - typical);
  return saved;
}

/** One rule with the group it sits in and what its full runs cost over a typical selected run. */
export interface RankedRule extends RuleRow {
  group: RuleGroup;
  /** The time its full runs could have saved; null where the period holds no selected run of the job to measure against. */
  savedMs: number | null;
  /** When the newest pull request it forced was merged. */
  lastForced: number;
  /** The first and last merge among the pull requests the job ran in the period. */
  span: [number, number];
}

/**
 * The rules that forced a full run, in three groups, each ranked by the time
 * its full runs could have saved, then by pull requests. A full run could have
 * saved the time its check held the pull request up, less a typical selected
 * run of the same job, never below zero for one run; a pull request cycle time
 * does not hold counts nothing. A rule that forced none of its job's latest
 * pull requests is stopped, whatever its mark; the rest are expected where
 * `expected` says so, and otherwise are to be fixed.
 */
export function rankRules(pulls: ViewPull[], jobs: Job[], checkMs: CheckMs, expected: (job: Job, rule: string) => boolean): { rules: RankedRule[]; typical: Record<Job, number | null> } {
  const typical: Record<Job, number | null> = { test: typicalSelectedMs(pulls, 'test', checkMs), e2e: typicalSelectedMs(pulls, 'e2e', checkMs) };
  const recent: Record<Job, Set<number>> = { test: new Set(), e2e: new Set() };
  const span: Record<Job, [number, number]> = { test: [0, 0], e2e: [0, 0] };
  for (const job of jobs) {
    const ran = pulls.filter((p) => jobOf(p, job).status === 'ran');
    for (const p of ran.slice(0, STOPPED_AFTER_PULLS)) recent[job].add(p.number);
    if (ran.length) span[job] = [Math.min(...ran.map((p) => p.mergedAt)), Math.max(...ran.map((p) => p.mergedAt))];
  }
  const rules = ruleRows(pulls, jobs).map((row): RankedRule => {
    const savedMs = totalSaved(row.job, row.everything, typical[row.job], checkMs);
    const stopped = ![...row.pulls.keys()].some((n) => recent[row.job].has(n));
    return {
      ...row,
      group: stopped ? 'stopped' : expected(row.job, row.rule) ? 'expected' : 'fix',
      savedMs,
      lastForced: Math.max(...[...row.pulls.values()].map((p) => p.mergedAt)),
      span: span[row.job],
    };
  });
  return {
    rules: rules.sort((a, b) => RULE_GROUPS.indexOf(a.group) - RULE_GROUPS.indexOf(b.group) || (b.savedMs ?? 0) - (a.savedMs ?? 0) || b.pulls.size - a.pulls.size || a.job.localeCompare(b.job) || a.rule.localeCompare(b.rule)),
    typical,
  };
}

/** What the first tile of each day says: the time the rules to fix could have saved, and every full run per job. */
export interface RanMoreThanNeeded {
  /** The time the full runs a rule to fix forced could have saved; null where no shown job has a typical selected run to measure against, and otherwise the sum over the jobs that have one, so a job without one adds nothing. */
  savedMs: number | null;
  /** How many full runs a rule to fix forced. */
  fixRuns: number;
  /** Every full run in the period, the expected ones and stopped rules' too, per job, against the pull requests the job ran. */
  perJob: { job: Job; full: number; ran: number }[];
  /** The time every one of those could have saved. */
  allSavedMs: number | null;
}

/**
 * The first tile of each day. A full run counts for the rules to fix when any
 * rule that forced it is one to fix (`rankRules`' own groups), so the figure
 * agrees with the table it opens and counts a pull request once however many
 * rules forced it.
 */
export function ranMoreThanNeeded(pulls: ViewPull[], jobs: Job[], checkMs: CheckMs, expected: (job: Job, rule: string) => boolean): RanMoreThanNeeded {
  const { rules, typical } = rankRules(pulls, jobs, checkMs, expected);
  const fix = new Set(rules.filter((r) => r.group === 'fix').flatMap((r) => [...r.everything].map((n) => checkKey(r.job, n))));
  const saved = (job: Job, runs: number[]) => totalSaved(job, runs, typical[job], checkMs);
  const sum = (parts: (number | null)[]) => (parts.every((part) => part === null) && parts.length > 0 ? null : parts.reduce<number>((all, part) => all + (part ?? 0), 0));
  const perJob = jobs.map((job) => {
    const ran = pulls.filter((p) => jobOf(p, job).status === 'ran');
    return { job, ran: ran.length, full: ran.filter((p) => jobOf(p, job).ranEverything).map((p) => p.number) };
  });
  return {
    savedMs: sum(perJob.map(({ job, full }) => saved(job, full.filter((n) => fix.has(checkKey(job, n)))))),
    fixRuns: fix.size,
    perJob: perJob.map(({ job, ran, full }) => ({ job, ran, full: full.length })),
    allSavedMs: sum(perJob.map(({ job, full }) => saved(job, full))),
  };
}

/** Where each job's rules live, and the tests that hold them. */
export const RULE_FILES: Record<Job, string> = { test: 'scripts/lib/test-selection.mjs', e2e: 'scripts/lib/e2e-selection.mjs' };
export const RULE_TESTS: Record<Job, string> = { test: 'scripts/lib/test-selection.test.mjs', e2e: 'scripts/lib/e2e-selection.test.mjs' };

/** The most paths, and the most pull requests of each, a rule's prompt lists. */
const PROMPT_PATHS = 25;
const PROMPT_PULLS = 6;

/**
 * What an agent in this repository is asked, to fix a rule: the rule and its
 * file, how often and when it forced a full run, every path worst first, the
 * time it could have saved, the advice the Monitor gives today, and the ask.
 */
export function rulePrompt(r: RankedRule, advice: string): string {
  const [unit, units] = UNIT[r.job];
  const every = r.job === 'e2e' ? 'every spec' : 'every test file of the packages it forced';
  const paths = [...r.paths.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  const listed = paths.slice(0, PROMPT_PATHS).map(([path, list]) => `- ${path}: ${plural(list.length, 'pull request')} (${list.slice(0, PROMPT_PULLS).map((p) => `#${p.number}`).join(', ')}${list.length > PROMPT_PULLS ? ', …' : ''})`);
  const rest = paths.length > PROMPT_PATHS ? [`- and ${plural(paths.length - PROMPT_PATHS, 'more path')}, each forcing ${paths.slice(PROMPT_PATHS).every(([, list]) => list.length === 1) ? 'one pull request' : 'a few'}`] : [];
  const range = `${formatDay(belgianDay(r.span[0]))} to ${formatDay(belgianDay(r.span[1]))}`;
  const saved = r.savedMs ? ` Selecting instead would have saved about ${humanMs(r.savedMs)} of CI time.` : '';
  return [
    `The ${JOB_NAMES[r.job]} ran ${every} on ${r.everything.size} of the ${r.of} pull requests merged ${range} that ran it, forced by the rule "${r.rule}" in ${RULE_FILES[r.job]}.${saved}`,
    '',
    'Paths that forced it, worst first:',
    ...listed,
    ...rest,
    '',
    `What the Harness Monitor says about the rule today: ${advice}`,
    '',
    `For each path, find what in it really forces ${every}. Where a change to it can only affect some ${units}, change the selection so it runs only those, and prove it with a case in ${RULE_TESTS[r.job]}. Never let a ${unit} be skipped that the change could break. Where a path should keep forcing a full run, say so and why. Paths that share one cause share one fix. Scope the fix with /scoping before building it.`,
  ].join('\n');
}

/** One test or spec that failed on main after its pull request skipped it. */
export interface MissRow {
  pull: ViewPull;
  job: Job;
  path: string;
  level: string;
  /** `docs only` where the pull request changed only documents, so its job never started. */
  reason: string | null;
}

/** The misses of the pull requests the jobs ran, newest pull request first. */
export const missRows = (pulls: ViewPull[], jobs: Job[]): MissRow[] =>
  pulls.flatMap((pull) => jobs.flatMap((job) => jobOf(pull, job).misses.map((m): MissRow => ({ pull, job, path: m.path, level: m.level, reason: m.reason }))));

/**
 * What an agent in this repository is asked, to settle a miss: which test, in
 * which job, on which pull request and when it merged, and the two outcomes it
 * has to tell apart, the selection that skipped what it should have run and a
 * test that is flaky or broken.
 */
export function missPrompt(m: MissRow): string {
  const { pull: p } = m;
  return [
    `${m.path} (${m.level}, ${JOB_NAMES[m.job]}) failed on main's run of the merge of #${p.number} "${p.title}" (merged ${formatDateTime(p.mergedAt)}), and #${p.number}'s own last run did not run it${m.reason === 'docs only' ? ', its change being documentation only' : ''}.`,
    '',
    `Decide whether #${p.number}'s change could have broken it: compare what the change touched with what the test exercises, and look at main's runs of this test around the merge. If the change could have broken it, find the import or runtime edge the selection did not follow, close it in ${RULE_FILES[m.job]}${m.job === 'test' ? " (or the package's Vitest config)" : ''}, and prove it with a case in ${RULE_TESTS[m.job]}. If it could not, say what did break it, so it is treated as a flaky or broken test rather than a selection gap. Scope any fix with /scoping before building it.`,
  ].join('\n');
}

export const jobsOf = (job: JobFilter): Job[] => (job === 'both' ? ['test', 'e2e'] : [job]);
