import { CHECK_NAMES, checkKey, type JobFilter, inPeriod, MOST_SELECTED, type PullRef, refOf, SCOPE } from './selection-store';
import type { BarId, SelectionJob, SelectionStatus } from './selection';

/**
 * What the test selection page reads of the stored rows. The queries only
 * gather, and each tab asks for its own (`ViewWants`), so one view is one batch
 * and no tab pays for another's rows; every figure the page draws is worked out
 * in selection-report.ts.
 */

/** One job's half of a pull request, as the page draws it: what it did, the rules that forced a package to run whole, and the misses. */
export interface ViewJob {
  status: SelectionStatus;
  ranEverything: boolean;
  selecting: boolean;
  filesRun: number | null;
  filesTotal: number | null;
  prDurationMs: number | null;
  mainDurationMs: number | null;
  /** How many changed files the job's selection placed on no walk; null where not recorded. */
  unplacedFiles: number | null;
  reasons: { rule: string; path: string | null }[];
  misses: { path: string; level: string; reason: string | null }[];
}

export interface ViewPull {
  number: number;
  title: string;
  url: string;
  mergedAt: number;
  jobs: Partial<Record<SelectionJob, ViewJob>>;
}

/** A test file or spec over the period: on how many pull requests it was selected, on how many it ran with its package whole, and on how many its package selected at all. */
export interface TallyRow {
  job: SelectionJob;
  path: string;
  level: string;
  selected: number;
  selecting: number;
  fullRun: number;
  chain: string | null;
}

export interface PackageRun {
  job: SelectionJob;
  name: string;
  mode: 'full' | 'changed';
  /** 'none' where its process wrote no report: what it ran is then unknown, not nothing. */
  report: 'written' | 'none';
  rule: string | null;
  /** The files it ran on that pull request. */
  ran: number;
  /** Every test file it held on that pull request, ran or skipped; null where not recorded. */
  filesTotal: number | null;
}

export interface StoredBar {
  id: BarId;
  threshold: number;
  minOver: number | null;
  minPulls: number;
  alarmIssue: number | null;
}

/** One pull request's whole selection: the files that changed, each package's mode and what it ran, and the files selected with why. */
export interface PullDrill {
  pull: ViewPull | null;
  changed: { path: string; ignored: boolean }[];
  packages: { job: SelectionJob; name: string; mode: 'full' | 'changed'; report: 'written' | 'none'; rule: string | null; path: string | null; ran: number; failed: number; filesTotal: number | null }[];
  files: { job: SelectionJob; package: string; path: string; status: 'passed' | 'failed'; text: string | null }[];
}

/** One test's file rows over the period, and how many pull requests each of its packages selected on. */
export interface TestDrill {
  rows: { job: SelectionJob; package: string; level: string; kind: string; status: 'passed' | 'failed'; text: string | null; pull: PullRef }[];
  selecting: { job: SelectionJob; package: string; pulls: number }[];
}

export interface SelectionView {
  pulls: ViewPull[];
  bars: StoredBar[];
  /** When the oldest stored pull request merged. */
  oldest: number | null;
  tally: TallyRow[];
  /** How many files were selected at least once in the period. */
  tallyCount: number;
  worst: TallyRow | null;
  packages: PackageRun[];
  pullDrill: PullDrill | null;
  testDrill: TestDrill | null;
  /** The time each pull request's Test and E2E checks held it up in cycle time's rounds, by `checkKey` (selection-store.ts); empty where the view did not ask. */
  checkMs: Map<string, number>;
}

/** What a view needs read. */
export interface ViewWants {
  /** The period's pull requests, with `reasons` (why a package ran whole) and `misses` laid on their jobs. */
  pulls: boolean;
  reasons: boolean;
  misses: boolean;
  /** How many of the most selected files to read; 0 reads only the bar's one, null none. */
  tally: number | null;
  packages: boolean;
  /** How long the period's pull requests' Test and E2E checks held them up, from cycle time's rows. */
  checks: boolean;
  /** One pull request's whole selection, whatever the period. */
  pull: number | null;
  /** One test's file rows. */
  test: string | null;
}

const PULL_COLUMNS = 'p.pull_number, p.job, p.title, p.url, p.merged_at, p.status, p.ran_everything, p.selecting, p.files_run, p.files_total, p.pr_duration_ms, p.main_duration_ms, p.unplaced_files';

interface ViewRow {
  pull_number: number;
  job: SelectionJob;
  title: string;
  url: string;
  merged_at: number;
  status: SelectionStatus;
  ran_everything: number;
  selecting: number;
  files_run: number | null;
  files_total: number | null;
  pr_duration_ms: number | null;
  main_duration_ms: number | null;
  unplaced_files: number | null;
}

/** The pull requests the rows name, in the order the rows come, each with the jobs the rows carry. */
function pullsOf(rows: ViewRow[]): ViewPull[] {
  const pulls = new Map<number, ViewPull>();
  for (const row of rows) {
    const pull = pulls.get(row.pull_number) ?? { number: row.pull_number, title: row.title, url: row.url, mergedAt: row.merged_at, jobs: {} };
    pulls.set(row.pull_number, pull);
    pull.jobs[row.job] = {
      status: row.status,
      ranEverything: row.ran_everything === 1,
      selecting: row.selecting === 1,
      filesRun: row.files_run,
      filesTotal: row.files_total,
      prDurationMs: row.pr_duration_ms,
      mainDurationMs: row.main_duration_ms,
      unplacedFiles: row.unplaced_files,
      reasons: [],
      misses: [],
    };
  }
  return [...pulls.values()];
}

const addOnce = (list: { rule: string; path: string | null }[], item: { rule: string; path: string | null }) => {
  if (!list.some((each) => each.rule === item.rule && each.path === item.path)) list.push(item);
};

type TallyRowRead = { kind: 'top' | 'worst' | 'count'; job: SelectionJob; path: string; level: string; selected: number; selecting: number; full_run: number; chain: string | null };
const tallyOf = (row: TallyRowRead): TallyRow => ({ job: row.job, path: row.path, level: row.level, selected: row.selected, selecting: row.selecting, fullRun: row.full_run, chain: row.chain });

/** The job filter against a table aliased `x`. */
const OF_JOB = "(?2 = 'both' OR x.job = ?2)";

/**
 * Everything a view of the page draws, in one batch: the statements the tab
 * asks for (`wants`), over the period starting at `from` (epoch milliseconds,
 * the start of its first Belgian day) and the job filter.
 */
export async function selectionView(db: D1Database, wants: ViewWants, from: number, job: JobFilter): Promise<SelectionView> {
  const statements: { key: string; statement: D1PreparedStatement }[] = [
    { key: 'bars', statement: db.prepare('SELECT id, threshold, min_over, min_pulls, alarm_issue FROM selection_bars') },
    { key: 'oldest', statement: db.prepare('SELECT MIN(merged_at) AS oldest FROM selection_pulls') },
  ];
  const add = (key: string, statement: D1PreparedStatement) => statements.push({ key, statement });

  if (wants.pulls) {
    add('pulls', db.prepare(`SELECT ${PULL_COLUMNS} FROM selection_pulls p WHERE ${inPeriod} ORDER BY p.merged_at DESC, p.pull_number DESC, p.job`).bind(from, job));
  }
  if (wants.reasons) {
    add(
      'reasons',
      db
        .prepare(
          `SELECT k.pull_number, k.job, k.reason_rule AS rule, k.reason_path AS path
           FROM selection_packages k JOIN selection_pulls p ON p.pull_number = k.pull_number AND p.job = k.job
           WHERE ${inPeriod} AND p.status = 'ran' AND k.mode = 'full' AND k.reason_rule IS NOT NULL ORDER BY k.pull_number, k.job, k.name`,
        )
        .bind(from, job),
    );
  }
  if (wants.misses) {
    add(
      'misses',
      db
        .prepare(
          `SELECT m.pull_number, m.job, m.path, m.level, m.reason FROM selection_misses m JOIN selection_pulls p ON p.pull_number = m.pull_number AND p.job = m.job
           WHERE ${inPeriod} ORDER BY m.pull_number, m.job, m.position`,
        )
        .bind(from, job),
    );
  }
  if (wants.tally !== null) add('tally', db.prepare(MOST_SELECTED).bind(from, job, wants.tally));
  if (wants.packages) {
    add(
      'packages',
      db
        .prepare(
          `WITH ${SCOPE}
           SELECT k.job, k.name, k.mode, k.report, k.reason_rule AS rule, k.files_total AS filesTotal,
                  (SELECT COUNT(*) FROM selection_files f WHERE f.pull_number = k.pull_number AND f.job = k.job AND f.package = k.name) AS ran
           FROM selection_packages k JOIN scoped s ON s.pull_number = k.pull_number AND s.job = k.job`,
        )
        .bind(from, job),
    );
  }
  if (wants.checks) {
    add(
      'checks',
      db
        .prepare(
          `SELECT c.pull_number, c.name, SUM(c.held_ms) AS ms
           FROM cycle_time_checks c JOIN cycle_time_pulls p ON p.pull_number = c.pull_number
           WHERE p.merged_at >= ?1 AND c.name IN (${Object.values(CHECK_NAMES).map((name) => `'${name}'`).join(', ')})
           GROUP BY c.pull_number, c.name`,
        )
        .bind(from),
    );
  }
  if (wants.pull !== null) {
    const pull = wants.pull;
    add('pull', db.prepare(`SELECT ${PULL_COLUMNS} FROM selection_pulls p WHERE p.pull_number = ?1 AND (?2 = 'both' OR p.job = ?2) ORDER BY p.job`).bind(pull, job));
    add('pull-misses', db.prepare(`SELECT x.job, x.path, x.level, x.reason FROM selection_misses x WHERE x.pull_number = ?1 AND ${OF_JOB} ORDER BY x.job, x.position`).bind(pull, job));
    add('pull-changed', db.prepare(`SELECT x.path, MIN(x.ignored) AS ignored FROM selection_changed_files x WHERE x.pull_number = ?1 AND ${OF_JOB} GROUP BY x.path ORDER BY x.path`).bind(pull, job));
    add(
      'pull-packages',
      db
        .prepare(
          `SELECT x.job, x.name, x.mode, x.report, x.reason_rule AS rule, x.reason_path AS path, x.files_total AS filesTotal,
                  (SELECT COUNT(*) FROM selection_files f WHERE f.pull_number = x.pull_number AND f.job = x.job AND f.package = x.name) AS ran,
                  (SELECT COUNT(*) FROM selection_files f WHERE f.pull_number = x.pull_number AND f.job = x.job AND f.package = x.name AND f.status = 'failed') AS failed
           FROM selection_packages x WHERE x.pull_number = ?1 AND ${OF_JOB} ORDER BY x.job, x.name`,
        )
        .bind(pull, job),
    );
    add(
      'pull-files',
      db
        .prepare(`SELECT x.job, x.package, x.path, x.status, x.chain_text AS text FROM selection_files x WHERE x.pull_number = ?1 AND x.chain_kind <> 'full' AND ${OF_JOB} ORDER BY x.job, x.package, x.path`)
        .bind(pull, job),
    );
  }
  if (wants.test !== null) {
    add(
      'test-rows',
      db
        .prepare(
          `SELECT f.job, f.package, f.level, f.chain_kind AS kind, f.status, f.chain_text AS text, p.pull_number, p.title, p.url, p.merged_at
           FROM selection_files f JOIN selection_pulls p ON p.pull_number = f.pull_number AND p.job = f.job
           WHERE f.job IN ('test', 'e2e') AND f.path = ?3 AND ${inPeriod} ORDER BY p.merged_at DESC, p.pull_number DESC`,
        )
        .bind(from, job, wants.test),
    );
    add(
      'test-selecting',
      db
        .prepare(
          `SELECT k.job, k.name AS package, COUNT(*) AS pulls
           FROM selection_packages k JOIN selection_pulls p ON p.pull_number = k.pull_number AND p.job = k.job
           WHERE ${inPeriod} AND p.status = 'ran' AND k.mode = 'changed' AND k.report = 'written'
             AND (k.job, k.name) IN (SELECT DISTINCT job, package FROM selection_files WHERE job IN ('test', 'e2e') AND path = ?3)
           GROUP BY k.job, k.name`,
        )
        .bind(from, job, wants.test),
    );
  }

  const results = await db.batch(statements.map((each) => each.statement));
  const rows = <T>(key: string): T[] => (results[statements.findIndex((each) => each.key === key)]?.results ?? []) as unknown as T[];

  const pulls = pullsOf(rows<ViewRow>('pulls'));
  const byNumber = new Map(pulls.map((pull) => [pull.number, pull]));
  for (const reason of rows<{ pull_number: number; job: SelectionJob; rule: string; path: string | null }>('reasons')) {
    const own = byNumber.get(reason.pull_number)?.jobs[reason.job];
    if (own) addOnce(own.reasons, { rule: reason.rule, path: reason.path });
  }
  for (const miss of rows<{ pull_number: number; job: SelectionJob; path: string; level: string; reason: string | null }>('misses')) {
    byNumber.get(miss.pull_number)?.jobs[miss.job]?.misses.push({ path: miss.path, level: miss.level, reason: miss.reason });
  }

  const tally = rows<TallyRowRead>('tally');
  const worst = tally.find((row) => row.kind === 'worst');

  let pullDrill: PullDrill | null = null;
  if (wants.pull !== null) {
    const found = pullsOf(rows<ViewRow>('pull'))[0] ?? null;
    const packages = rows<PullDrill['packages'][number]>('pull-packages');
    if (found) {
      for (const each of packages) if (each.rule) addOnce(found.jobs[each.job]?.reasons ?? [], { rule: each.rule, path: each.path });
      for (const miss of rows<{ job: SelectionJob; path: string; level: string; reason: string | null }>('pull-misses')) {
        found.jobs[miss.job]?.misses.push({ path: miss.path, level: miss.level, reason: miss.reason });
      }
    }
    pullDrill = {
      pull: found,
      changed: rows<{ path: string; ignored: number }>('pull-changed').map((row) => ({ path: row.path, ignored: row.ignored === 1 })),
      packages,
      files: rows<PullDrill['files'][number]>('pull-files'),
    };
  }

  let testDrill: TestDrill | null = null;
  if (wants.test !== null) {
    testDrill = {
      rows: rows<{ job: SelectionJob; package: string; level: string; kind: string; status: 'passed' | 'failed'; text: string | null; pull_number: number; title: string; url: string; merged_at: number }>('test-rows').map(
        (row) => ({ job: row.job, package: row.package, level: row.level, kind: row.kind, status: row.status, text: row.text, pull: refOf(row) }),
      ),
      selecting: rows<TestDrill['selecting'][number]>('test-selecting'),
    };
  }

  return {
    pulls,
    bars: rows<{ id: BarId; threshold: number; min_over: number | null; min_pulls: number; alarm_issue: number | null }>('bars').map((row) => ({
      id: row.id,
      threshold: row.threshold,
      minOver: row.min_over,
      minPulls: row.min_pulls,
      alarmIssue: row.alarm_issue,
    })),
    oldest: rows<{ oldest: number | null }>('oldest')[0]?.oldest ?? null,
    tally: tally.filter((row) => row.kind === 'top').map(tallyOf),
    tallyCount: tally.find((row) => row.kind === 'count')?.selected ?? 0,
    worst: worst ? tallyOf(worst) : null,
    packages: rows<PackageRun>('packages'),
    pullDrill,
    testDrill,
    checkMs: new Map(rows<{ pull_number: number; name: string; ms: number }>('checks').map((row) => [checkKey(row.name === CHECK_NAMES.test ? 'test' : 'e2e', row.pull_number), row.ms])),
  };
}
