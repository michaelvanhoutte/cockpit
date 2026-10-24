import { addDays, belgianDay, startOfDay } from './belgium';
import {
  type BarId,
  JOBS,
  type SelectionBars,
  type SelectionJob,
  type SelectionPull,
  type SelectionStatus,
} from './selection';

/** The periods the answer takes, in days. 14 is the window the bars were written for, so it is the one the bare address reads. */
export const SELECTION_PERIODS = { '7d': 7, '14d': 14, '30d': 30, '90d': 90, all: null } as const;
export type SelectionPeriod = keyof typeof SELECTION_PERIODS;
export const DEFAULT_SELECTION_PERIOD: SelectionPeriod = '14d';

export type JobFilter = 'both' | SelectionJob;

export function parseSelectionPeriod(raw: string | null): SelectionPeriod {
  return raw !== null && Object.hasOwn(SELECTION_PERIODS, raw) ? (raw as SelectionPeriod) : DEFAULT_SELECTION_PERIOD;
}

export function parseJobFilter(raw: string | null): JobFilter {
  return raw === 'test' || raw === 'e2e' ? raw : 'both';
}

// Each insert reads one JSON array whose objects are named as the columns are,
// so a batch is a handful of statements whatever it holds.
const insertFrom = (table: string, columns: readonly string[], extra: Record<string, string> = {}) =>
  `INSERT INTO ${table} (${columns.join(', ')}) SELECT ${columns.map((c) => extra[c] ?? `value ->> '$.${c}'`).join(', ')} FROM json_each(?1)`;

const PULL_COLUMNS = [
  'pull_number', 'job', 'title', 'url', 'merged_at', 'status', 'ran_everything', 'selecting', 'files_run', 'files_total', 'pr_duration_ms', 'main_duration_ms', 'received_at',
] as const;
const PACKAGE_COLUMNS = ['pull_number', 'job', 'name', 'dir', 'mode', 'report', 'reason_rule', 'reason_path'] as const;
const FILE_COLUMNS = ['pull_number', 'job', 'package', 'path', 'level', 'status', 'chain_kind', 'chain', 'chain_text'] as const;
const CHANGED_COLUMNS = ['pull_number', 'job', 'path', 'ignored'] as const;
const MISS_COLUMNS = ['pull_number', 'job', 'position', 'path', 'level', 'reason'] as const;

const UPSERT_PULLS = `${insertFrom('selection_pulls', PULL_COLUMNS)} WHERE true
ON CONFLICT (pull_number, job) DO UPDATE SET ${PULL_COLUMNS.filter((c) => c !== 'pull_number' && c !== 'job')
  .map((c) => `${c} = excluded.${c}`)
  .join(', ')}`;

// `->` keeps a chain as the JSON it was sent as; a file with none omits the key, which reads back null.
const INSERT_FILES = insertFrom('selection_files', FILE_COLUMNS, { chain: "value -> '$.chain'" });

const UPSERT_BARS = `INSERT INTO selection_bars (id, name, threshold, min_over, window_days, min_pulls, received_at)
SELECT value ->> '$.id', value ->> '$.name', value ->> '$.threshold', value ->> '$.minOver', ?2, ?3, ?4 FROM json_each(?1) WHERE true
ON CONFLICT (id) DO UPDATE SET name = excluded.name, threshold = excluded.threshold, min_over = excluded.min_over,
  window_days = excluded.window_days, min_pulls = excluded.min_pulls, received_at = excluded.received_at`;

// A send that could not read the alarm issues carries none, and the stored ones stand.
const UPDATE_ALARMS = `UPDATE selection_bars SET alarm_issue = alarm.number
FROM (SELECT value ->> '$.id' AS id, value ->> '$.alarmIssue' AS number FROM json_each(?1) WHERE json_type(value, '$.alarmIssue') IS NOT NULL) AS alarm
WHERE selection_bars.id = alarm.id`;

const bit = (value: boolean) => (value ? 1 : 0);

/**
 * Stores a send's pull requests, each job of each replacing the one stored
 * under its pull request number and job with every package, file, changed file
 * and miss beneath it, and the bars' thresholds replacing the stored ones, so a
 * re-send or an overlapping one never doubles a row and a miss found since
 * lands. One D1 batch, one transaction: a send lands whole or not at all, in
 * eleven statements whatever its size.
 */
export async function storeSelection(db: D1Database, pulls: SelectionPull[], bars: SelectionBars, now = Date.now()): Promise<{ stored: number }> {
  const ids = JSON.stringify(pulls.map((p) => p.number));
  const jobs = pulls.flatMap((p) => p.jobs.map((j) => ({ p, j })));
  const pullRows = jobs.map(({ p, j }) => ({
    pull_number: p.number, job: j.job, title: p.title, url: p.url, merged_at: p.mergedAt, status: j.status, ran_everything: bit(j.ranEverything), selecting: bit(j.selecting),
    files_run: j.filesRun, files_total: j.filesTotal, pr_duration_ms: j.prDurationMs, main_duration_ms: j.mainDurationMs, received_at: now,
  }));
  const packageRows = jobs.flatMap(({ p, j }) =>
    j.packages.map((k) => ({ pull_number: p.number, job: j.job, name: k.name, dir: k.dir, mode: k.mode, report: k.report, reason_rule: k.reason?.rule ?? null, reason_path: k.reason?.path ?? null })),
  );
  const fileRows = jobs.flatMap(({ p, j }) =>
    j.packages.flatMap((k) =>
      k.files.map((f) => ({
        pull_number: p.number, job: j.job, package: k.name, path: f.path, level: f.level, status: f.status, chain_kind: f.selectedBy.kind,
        ...(f.selectedBy.kind === 'chain' ? { chain: f.selectedBy.chain } : f.selectedBy.kind === 'concept' ? { chain: f.selectedBy.owners } : {}),
        ...(f.selectedBy.kind === 'full' ? {} : { chain_text: f.selectedBy.text }),
      })),
    ),
  );
  const changedRows = jobs.flatMap(({ p, j }) => j.changedFiles.map((c) => ({ pull_number: p.number, job: j.job, path: c.path, ignored: bit(c.ignored) })));
  const missRows = pulls.flatMap((p) => p.misses.map((m, position) => ({ pull_number: p.number, job: m.job, position, path: m.path, level: m.level, reason: m.reason })));
  const barRows = JSON.stringify(bars.items);

  await db.batch([
    db.prepare(UPSERT_PULLS).bind(JSON.stringify(pullRows)),
    db.prepare('DELETE FROM selection_files WHERE pull_number IN (SELECT value FROM json_each(?1))').bind(ids),
    db.prepare('DELETE FROM selection_packages WHERE pull_number IN (SELECT value FROM json_each(?1))').bind(ids),
    db.prepare('DELETE FROM selection_changed_files WHERE pull_number IN (SELECT value FROM json_each(?1))').bind(ids),
    db.prepare('DELETE FROM selection_misses WHERE pull_number IN (SELECT value FROM json_each(?1))').bind(ids),
    db.prepare(insertFrom('selection_packages', PACKAGE_COLUMNS)).bind(JSON.stringify(packageRows)),
    db.prepare(INSERT_FILES).bind(JSON.stringify(fileRows)),
    db.prepare(insertFrom('selection_changed_files', CHANGED_COLUMNS)).bind(JSON.stringify(changedRows)),
    db.prepare(insertFrom('selection_misses', MISS_COLUMNS)).bind(JSON.stringify(missRows)),
    db.prepare(UPSERT_BARS).bind(barRows, bars.windowDays, bars.minPulls, now),
    db.prepare(UPDATE_ALARMS).bind(barRows),
  ]);
  return { stored: pulls.length };
}

/** When the newest stored pull request merged, as ISO time, or null when none is stored: where the next send starts reading. */
export async function newestSelectionMerge(db: D1Database): Promise<string | null> {
  const row = await db.prepare('SELECT MAX(merged_at) AS newest FROM selection_pulls').first<{ newest: number | null }>();
  return row?.newest == null ? null : new Date(row.newest).toISOString();
}

export interface PullRef {
  number: number;
  title: string;
  url: string;
  mergedAt: string;
}

export interface SelectionBar {
  id: BarId;
  name: string;
  /** The job the bar is read on: its own for the forced-full bars, the filter for the others. */
  job: JobFilter;
  count: number | null;
  of: number | null;
  value: number | null;
  threshold: number;
  minOver: number | null;
  /** The test file or spec behind a most-selected bar. */
  path: string | null;
  /** The rule that forced the most of the pull requests that ran everything, for a forced-full bar. */
  cause: { rule: string; count: number } | null;
  /** crossed or within; unread where the period holds fewer pull requests than the bars need or the figure cannot be given. */
  verdict: 'crossed' | 'within' | 'unread';
  unread: 'window' | 'figure' | null;
  alarmIssue: number | null;
}

export interface ForcedFullRule {
  job: SelectionJob;
  rule: string;
  /** The pull requests the rule forced a package of the job on, and the ones that ran it. */
  count: number;
  of: number;
  /** The share of those that ran the job that the rule left running everything, which the bar reads. */
  share: number | null;
  verdict: 'crossed' | 'within' | 'unread';
  pulls: PullRef[];
  paths: { path: string | null; count: number; pulls: number[] }[];
}

export interface SelectionMissRow {
  job: SelectionJob;
  path: string;
  level: string;
  reason: string | null;
  pull: PullRef;
}

export interface MostSelected {
  job: SelectionJob;
  path: string;
  level: string;
  selectedPulls: number;
  /** The pull requests whose package selected rather than ran everything: those that could have skipped it. */
  selectingPulls: number;
  fullRunPulls: number;
  mostCommonChain: string | null;
}

export interface SelectionAnswer {
  period: SelectionPeriod;
  job: JobFilter;
  /** The first Belgian day inside the period; null for every stored pull request. */
  firstDay: string | null;
  /** When the oldest stored pull request merged, so a reader can tell a period the Monitor holds only part of. */
  storedFrom: string | null;
  pulls: {
    total: number;
    jobs: { job: SelectionJob; ran: number; docsOnly: number; noRecord: number; ranEverything: number; selecting: number }[];
  };
  bars: { windowDays: number | null; minPulls: number | null; read: boolean; items: SelectionBar[] };
  forcedFullRules: ForcedFullRule[];
  misses: SelectionMissRow[];
  mostSelected: MostSelected[];
}

const MOST_SELECTED_ROWS = 15;

interface PullRow {
  pull_number: number;
  job: SelectionJob;
  title: string;
  url: string;
  merged_at: number;
  status: SelectionStatus;
  ran_everything: number;
}

export const inPeriod = `p.merged_at >= ?1 AND (?2 = 'both' OR p.job = ?2)`;

/** The pull requests of the period that ran a job, and the packages of those: the scope the file queries count over. */
export const SCOPE = `scoped AS (SELECT pull_number, job, merged_at FROM selection_pulls p WHERE status = 'ran' AND ${inPeriod})`;

/**
 * Per package, the pull requests that selected in it rather than ran it whole
 * (and whose process wrote its report): what a file of it could have skipped.
 * `tally` is the one pass over the period's file rows, which both the table and
 * the bar read.
 */
const SELECTING = `selecting AS (
  SELECT k.job, k.name AS package, COUNT(*) AS pulls FROM selection_packages k JOIN scoped s ON s.pull_number = k.pull_number AND s.job = k.job
  WHERE k.mode = 'changed' AND k.report = 'written' GROUP BY k.job, k.name
), tally AS MATERIALIZED (
  SELECT f.job, f.package, f.path, MAX(f.level) AS level, SUM(f.chain_kind <> 'full') AS selected, SUM(f.chain_kind = 'full') AS full_run
  FROM selection_files f JOIN scoped s ON s.pull_number = f.pull_number AND s.job = f.job GROUP BY f.job, f.package, f.path
)`;

/**
 * The table's rows (`top`, in order) and the bar's one file (`worst`), in one statement so the
 * period's file rows are grouped once. `worst` is the file selected on the largest share of the
 * pull requests that could have skipped it, among those with at least the bar's `min_over` of them.
 */
export const MOST_SELECTED = `WITH ${SCOPE}, ${SELECTING}
SELECT 'top' AS kind, ROW_NUMBER() OVER (ORDER BY r.selected DESC, r.full_run DESC, r.path) AS rank, r.job, r.path, r.selected, r.selecting, r.full_run, r.level, (
  SELECT f.chain_text FROM selection_files f JOIN scoped s ON s.pull_number = f.pull_number AND s.job = f.job
  WHERE f.job = r.job AND f.path = r.path AND f.chain_kind <> 'full'
  GROUP BY f.chain_text ORDER BY COUNT(*) DESC, MAX(s.merged_at) DESC LIMIT 1
) AS chain
FROM (
  SELECT t.job, t.path, t.level, t.selected, t.full_run, COALESCE(c.pulls, 0) AS selecting
  FROM tally t LEFT JOIN selecting c ON c.job = t.job AND c.package = t.package
  ORDER BY t.selected DESC, t.full_run DESC, t.path LIMIT ?3
) r
UNION ALL
SELECT * FROM (
  SELECT 'worst', 1, t.job, t.path, t.selected, c.pulls, t.full_run, t.level, NULL
  FROM tally t JOIN selecting c ON c.job = t.job AND c.package = t.package
  WHERE c.pulls >= (SELECT min_over FROM selection_bars WHERE id = 'most-selected')
  ORDER BY t.selected * 1.0 / c.pulls DESC, c.pulls DESC, t.path LIMIT 1
)
UNION ALL
SELECT 'count', 1, NULL, NULL, COUNT(*), NULL, NULL, NULL, NULL FROM tally WHERE selected > 0
ORDER BY 1, 2`;

const share = (count: number, of: number) => (of > 0 ? count / of : null);

/** A share against its bar. Unread wherever the period is too small or the figure cannot be given, never within. The tolerance keeps 29 of 116 (exactly a quarter) on the right side of a float. */
export function verdictOf(read: boolean, value: number | null, threshold: number): SelectionBar['verdict'] {
  if (!read || value === null) return 'unread';
  return value + 1e-9 >= threshold ? 'crossed' : 'within';
}

/** Of the pull requests that ran everything, the rule that forced the most of them (a pull request counted once per rule), or null where none names one. */
export function leadingRule(rulesOf: string[][]): { rule: string; count: number } | null {
  const tally = new Map<string, number>();
  for (const rules of rulesOf) for (const rule of new Set(rules)) tally.set(rule, (tally.get(rule) ?? 0) + 1);
  const [leader] = [...tally].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return leader ? { rule: leader[0], count: leader[1] } : null;
}

export const refOf = (row: { pull_number: number; title: string; url: string; merged_at: number }): PullRef => ({
  number: row.pull_number,
  title: row.title,
  url: row.url,
  mergedAt: new Date(row.merged_at).toISOString(),
});

interface BarRow {
  id: BarId;
  name: string;
  threshold: number;
  min_over: number | null;
  window_days: number;
  min_pulls: number;
  alarm_issue: number | null;
}

/**
 * The stored pull requests of a period and job: how many ran, ran everything
 * or were documentation only, each bar read against the thresholds the last
 * send carried, the rules that forced a full run with their paths, the misses
 * and the files selected most often. A period starts at the beginning of its
 * first Belgian day. One batch.
 */
export async function selectionAnswer(db: D1Database, period: SelectionPeriod, job: JobFilter, now: number): Promise<SelectionAnswer> {
  const length = SELECTION_PERIODS[period];
  const firstDay = length === null ? null : addDays(belgianDay(now), -(length - 1));
  const from = firstDay === null ? 0 : startOfDay(firstDay);

  const [pulls, reasons, misses, bars, selected, oldest] = await db.batch([
    db.prepare(`SELECT p.pull_number, p.job, p.title, p.url, p.merged_at, p.status, p.ran_everything FROM selection_pulls p WHERE ${inPeriod} ORDER BY p.merged_at DESC, p.pull_number DESC, p.job`).bind(from, job),
    db.prepare(
      `SELECT DISTINCT k.pull_number, k.job, k.reason_rule AS rule, k.reason_path AS path
       FROM selection_packages k JOIN selection_pulls p ON p.pull_number = k.pull_number AND p.job = k.job
       WHERE ${inPeriod} AND p.status = 'ran' AND k.mode = 'full' AND k.reason_rule IS NOT NULL`,
    ).bind(from, job),
    db.prepare(
      `SELECT m.job, m.path, m.level, m.reason, p.pull_number, p.title, p.url, p.merged_at
       FROM selection_misses m JOIN selection_pulls p ON p.pull_number = m.pull_number AND p.job = 'test'
       WHERE p.merged_at >= ?1 AND (?2 = 'both' OR m.job = ?2) ORDER BY p.merged_at DESC, p.pull_number DESC, m.position`,
    ).bind(from, job),
    db.prepare('SELECT id, name, threshold, min_over, window_days, min_pulls, alarm_issue FROM selection_bars'),
    db.prepare(MOST_SELECTED).bind(from, job, MOST_SELECTED_ROWS),
    db.prepare('SELECT MIN(merged_at) AS oldest FROM selection_pulls'),
  ]);
  const pullRows = pulls!.results as unknown as PullRow[];
  const reasonRows = reasons!.results as unknown as { pull_number: number; job: SelectionJob; rule: string; path: string | null }[];
  const barRows = bars!.results as unknown as BarRow[];

  const jobs = JOBS.filter((each) => job === 'both' || job === each);
  const total = new Set(pullRows.map((row) => row.pull_number)).size;
  const minPulls = barRows[0]?.min_pulls ?? null;
  const read = minPulls !== null && total >= minPulls;
  const setting = (id: BarId) => barRows.find((each) => each.id === id) ?? null;

  const selectedRows = selected!.results as unknown as { kind: 'top' | 'worst' | 'count'; job: SelectionJob; path: string; level: string; selected: number; selecting: number; full_run: number; chain: string | null }[];
  const reasonsOf = new Map<string, typeof reasonRows>();
  for (const reason of reasonRows) {
    const key = `${reason.job}:${reason.pull_number}`;
    reasonsOf.set(key, [...(reasonsOf.get(key) ?? []), reason]);
  }
  const rulesOf = (each: SelectionJob, number: number) => reasonsOf.get(`${each}:${number}`) ?? [];

  // A bar is read on the pull requests whose job left a record: a documentation-only or no-record one never had the chance to be forced full.
  const forcedBar = (each: SelectionJob): SelectionBar | null => {
    const id: BarId = `${each}-forced-full`;
    const stored = setting(id);
    if (!stored) return null;
    const ran = pullRows.filter((row) => row.job === each && row.status === 'ran');
    const everything = ran.filter((row) => row.ran_everything === 1);
    const value = ran.length === 0 ? null : share(everything.length, ran.length);
    const verdict = verdictOf(read, value, stored.threshold);
    return {
      id, name: stored.name, job: each, count: ran.length === 0 ? null : everything.length, of: ran.length === 0 ? null : ran.length, value,
      threshold: stored.threshold, minOver: null, path: null,
      cause: leadingRule(everything.map((row) => rulesOf(each, row.pull_number).map((r) => r.rule))),
      verdict, unread: verdict !== 'unread' ? null : read ? 'figure' : 'window', alarmIssue: stored.alarm_issue,
    };
  };
  const missBar = (): SelectionBar | null => {
    const stored = setting('misses');
    if (!stored) return null;
    const count = total === 0 ? null : misses!.results.length;
    const verdict = verdictOf(read, count, stored.threshold);
    return {
      id: 'misses', name: stored.name, job, count, of: null, value: count, threshold: stored.threshold, minOver: null, path: null, cause: null,
      verdict, unread: verdict !== 'unread' ? null : read ? 'figure' : 'window', alarmIssue: stored.alarm_issue,
    };
  };
  const mostBar = (): SelectionBar | null => {
    const stored = setting('most-selected');
    if (!stored) return null;
    const top = selectedRows.find((row) => row.kind === 'worst') ?? null;
    const value = top ? top.selected / top.selecting : null;
    const verdict = verdictOf(read, value, stored.threshold);
    return {
      id: 'most-selected', name: stored.name, job, count: top?.selected ?? null, of: top?.selecting ?? null, value, threshold: stored.threshold, minOver: stored.min_over, path: top?.path ?? null,
      cause: null, verdict, unread: verdict !== 'unread' ? null : read ? 'figure' : 'window', alarmIssue: stored.alarm_issue,
    };
  };
  const items = [forcedBar('e2e'), forcedBar('test'), missBar(), mostBar()].filter((bar): bar is SelectionBar => bar !== null && (bar.id !== 'e2e-forced-full' || jobs.includes('e2e')) && (bar.id !== 'test-forced-full' || jobs.includes('test')));

  const forcedFullRules: ForcedFullRule[] = [];
  for (const each of jobs) {
    const ran = pullRows.filter((row) => row.job === each && row.status === 'ran');
    const stored = setting(`${each}-forced-full`);
    const byRule = new Map<string, { pulls: Map<number, PullRef>; everything: Set<number>; paths: Map<string | null, number[]> }>();
    for (const row of ran) {
      for (const reason of rulesOf(each, row.pull_number)) {
        const entry = byRule.get(reason.rule) ?? { pulls: new Map(), everything: new Set(), paths: new Map() };
        byRule.set(reason.rule, entry);
        entry.pulls.set(row.pull_number, refOf(row));
        if (row.ran_everything === 1) entry.everything.add(row.pull_number);
        const own = entry.paths.get(reason.path) ?? [];
        entry.paths.set(reason.path, own);
        own.push(row.pull_number);
      }
    }
    for (const [rule, entry] of byRule) {
      // The bar is about running everything: a rule that forced one package of several is listed, but only the pull requests it left running everything are read against the bar.
      const value = share(entry.everything.size, ran.length);
      forcedFullRules.push({
        job: each, rule, count: entry.pulls.size, of: ran.length, share: share(entry.pulls.size, ran.length),
        verdict: stored ? verdictOf(read, value, stored.threshold) : 'unread',
        pulls: [...entry.pulls.values()],
        paths: [...entry.paths].map(([path, pullsOfPath]) => ({ path, count: pullsOfPath.length, pulls: pullsOfPath })).sort((a, b) => b.count - a.count || String(a.path).localeCompare(String(b.path))),
      });
    }
  }
  forcedFullRules.sort((a, b) => b.count - a.count || JOBS.indexOf(a.job) - JOBS.indexOf(b.job) || a.rule.localeCompare(b.rule));

  return {
    period,
    job,
    firstDay,
    storedFrom: (oldest!.results[0] as { oldest: number | null }).oldest === null ? null : new Date((oldest!.results[0] as { oldest: number }).oldest).toISOString(),
    pulls: {
      total,
      jobs: jobs.map((each) => {
        const own = pullRows.filter((row) => row.job === each);
        return {
          job: each,
          ran: own.filter((row) => row.status === 'ran').length,
          docsOnly: own.filter((row) => row.status === 'docs-only').length,
          noRecord: own.filter((row) => row.status === 'no-record').length,
          ranEverything: own.filter((row) => row.ran_everything === 1).length,
          selecting: own.filter((row) => row.status === 'ran' && row.ran_everything === 0).length,
        };
      }),
    },
    bars: { windowDays: barRows[0]?.window_days ?? null, minPulls, read, items },
    forcedFullRules,
    misses: (misses!.results as unknown as { job: SelectionJob; path: string; level: string; reason: string | null; pull_number: number; title: string; url: string; merged_at: number }[]).map(
      (row) => ({ job: row.job, path: row.path, level: row.level, reason: row.reason, pull: refOf(row) }),
    ),
    mostSelected: selectedRows
      .filter((row) => row.kind === 'top')
      .map((row) => ({ job: row.job, path: row.path, level: row.level, selectedPulls: row.selected, selectingPulls: row.selecting, fullRunPulls: row.full_run, mostCommonChain: row.chain })),
  };
}
