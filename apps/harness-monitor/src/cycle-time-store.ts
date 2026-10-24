import { addDays, belgianDay, startOfDay } from './belgium';
import { PERIODS, type Period } from './costs';
import type { CyclePull } from './cycle-time';

/** The windows each answer carries, in days, the shortest first: every one no longer than the period, and all of it for all time. 14 is the one `harness-cost-review` reads. */
const WINDOW_DAYS = [7, 14, 30, 90] as const;

/** A round that took longer than this is one somebody was kept waiting on, as the tool's model counts it. */
const LONG_ROUND_MS = 10 * 60_000;

const bit = (value: boolean) => (value ? 1 : 0);

/** What the harness took against the writing; null where there was no writing to weigh it against. */
const ratioOf = (harnessMs: number, codingMs: number) => (codingMs > 0 ? harnessMs / codingMs : null);

// Each insert reads one JSON array whose objects are named as the columns are,
// so a batch is a handful of statements whatever it holds.
const PULL_COLUMNS = [
  'pull_number', 'title', 'url', 'merged_at', 'base', 'head', 'landing', 'additions', 'deletions', 'changed_files', 'commits', 'main_merges',
  'started_at', 'start_from', 'recorded', 'coding_ms', 'local_ms', 'ci_ms', 'waiting_to_merge_ms', 'away_ms', 'total_ms',
  'review_count', 'review_ms', 'test_runs', 'test_ms', 'browser_runs', 'browser_ms',
  'runner_ms', 'superseded_runs', 'superseded_ms', 'cancelled_runs', 'cancelled_ms', 'received_at',
] as const;
const ROUND_COLUMNS = ['pull_number', 'round_index', 'sha', 'pushed_at', 'ended_at', 'ms', 'red', 'commits', 'queue_not_recorded'] as const;
const CHECK_COLUMNS = [
  'pull_number', 'round_index', 'position', 'name', 'attempt', 'held_ms', 'is_last', 'failure', 'fluke_ms', 'queued_ms', 'detail_not_recorded', 'no_file_failed',
] as const;
const FAILURE_COLUMNS = ['pull_number', 'round_index', 'position', 'kind', 'item_index', 'item'] as const;

const insertFrom = (table: string, columns: readonly string[]) =>
  `INSERT INTO ${table} (${columns.join(', ')}) SELECT ${columns.map((c) => `value ->> '$.${c}'`).join(', ')} FROM json_each(?1)`;

const UPSERT_PULLS = `${insertFrom('cycle_time_pulls', PULL_COLUMNS)} WHERE true
ON CONFLICT (pull_number) DO UPDATE SET ${PULL_COLUMNS.filter((c) => c !== 'pull_number')
  .map((c) => `${c} = excluded.${c}`)
  .join(', ')}`;

/**
 * Stores a send's pull requests, each replacing the pull request stored under
 * its number with every round, check and failing step or file beneath it, so a
 * re-send or an overlapping one never doubles a row and a fluke found since
 * lands. One D1 batch, one transaction: a send lands whole or not at all, in
 * seven statements whatever its size.
 */
export async function storePulls(db: D1Database, pulls: CyclePull[], now = Date.now()): Promise<{ stored: number }> {
  const ids = JSON.stringify(pulls.map((p) => p.number));
  const pullRows = pulls.map((p) => ({
    pull_number: p.number, title: p.title, url: p.url, merged_at: p.mergedAt, base: p.base, head: p.head, landing: bit(p.landing),
    additions: p.size.additions, deletions: p.size.deletions, changed_files: p.size.files, commits: p.size.commits, main_merges: p.size.mainMerges,
    started_at: p.startedAt, start_from: p.startFrom, recorded: bit(p.recorded), coding_ms: p.codingMs, local_ms: p.localMs, ci_ms: p.ciMs,
    waiting_to_merge_ms: p.waitingToMergeMs, away_ms: p.awayMs, total_ms: p.totalMs,
    review_count: p.localReviews?.count ?? null, review_ms: p.localReviews?.ms ?? null,
    test_runs: p.localTests?.count ?? null, test_ms: p.localTests?.ms ?? null,
    browser_runs: p.localBrowser?.count ?? null, browser_ms: p.localBrowser?.ms ?? null,
    runner_ms: p.runnerMs, superseded_runs: p.superseded.runs, superseded_ms: p.superseded.ms, cancelled_runs: p.cancelled.runs, cancelled_ms: p.cancelled.ms,
    received_at: now,
  }));
  const rounds = pulls.flatMap((p) =>
    p.rounds.map((r, round_index) => ({
      pull_number: p.number, round_index, sha: r.sha, pushed_at: r.pushedAt, ended_at: r.endedAt, ms: r.ms, red: bit(r.red), commits: r.commits,
      queue_not_recorded: bit(r.queueNotRecorded),
    })),
  );
  const checks = pulls.flatMap((p) =>
    p.rounds.flatMap((r, round_index) =>
      r.checks.map((c, position) => ({
        pull_number: p.number, round_index, position, name: c.name, attempt: c.attempt, held_ms: c.heldMs, is_last: bit(c.last), failure: c.failure,
        fluke_ms: c.flukeMs, queued_ms: c.queuedMs, detail_not_recorded: bit(c.detailNotRecorded), no_file_failed: bit(c.noFileFailed),
      })),
    ),
  );
  const failures = pulls.flatMap((p) =>
    p.rounds.flatMap((r, round_index) =>
      r.checks.flatMap((c, position) => [
        ...c.failedSteps.map((item, item_index) => ({ pull_number: p.number, round_index, position, kind: 'step', item_index, item })),
        ...c.failedFiles.map((item, item_index) => ({ pull_number: p.number, round_index, position, kind: 'file', item_index, item })),
      ]),
    ),
  );
  await db.batch([
    db.prepare(UPSERT_PULLS).bind(JSON.stringify(pullRows)),
    db.prepare('DELETE FROM cycle_time_failures WHERE pull_number IN (SELECT value FROM json_each(?1))').bind(ids),
    db.prepare('DELETE FROM cycle_time_checks WHERE pull_number IN (SELECT value FROM json_each(?1))').bind(ids),
    db.prepare('DELETE FROM cycle_time_rounds WHERE pull_number IN (SELECT value FROM json_each(?1))').bind(ids),
    db.prepare(insertFrom('cycle_time_rounds', ROUND_COLUMNS)).bind(JSON.stringify(rounds)),
    db.prepare(insertFrom('cycle_time_checks', CHECK_COLUMNS)).bind(JSON.stringify(checks)),
    db.prepare(insertFrom('cycle_time_failures', FAILURE_COLUMNS)).bind(JSON.stringify(failures)),
  ]);
  return { stored: pulls.length };
}

/** When the newest stored pull request merged, as ISO time, or null when none is stored: where the next send starts reading. */
export async function newestMerge(db: D1Database): Promise<string | null> {
  const row = await db.prepare('SELECT MAX(merged_at) AS newest FROM cycle_time_pulls').first<{ newest: number | null }>();
  return row?.newest == null ? null : new Date(row.newest).toISOString();
}

/** Median (the middle pair averaged on an even count), nearest-rank p95, the items behind them and the pull requests those came from; null for none. */
export interface Figure {
  median: number;
  p95: number;
  count: number;
  pulls: number;
}

function figure(entries: { pull: number; value: number }[]): Figure | null {
  if (entries.length === 0) return null;
  const sorted = entries.map((e) => e.value).sort((a, b) => a - b);
  const mid = sorted.length / 2;
  const median = sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[Math.floor(mid)]!;
  const rank = Math.max(1, Math.ceil(0.95 * sorted.length));
  return { median, p95: sorted[rank - 1]!, count: sorted.length, pulls: new Set(entries.map((e) => e.pull)).size };
}

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

interface PullRow {
  pull_number: number;
  title: string;
  url: string;
  merged_at: number;
  base: string;
  head: string | null;
  landing: number;
  additions: number;
  deletions: number;
  changed_files: number;
  commits: number;
  main_merges: number;
  started_at: number;
  start_from: string;
  recorded: number;
  coding_ms: number | null;
  local_ms: number | null;
  ci_ms: number;
  waiting_to_merge_ms: number | null;
  away_ms: number;
  total_ms: number;
  review_count: number | null;
  review_ms: number | null;
  test_runs: number | null;
  test_ms: number | null;
  browser_runs: number | null;
  browser_ms: number | null;
  runner_ms: number;
  superseded_runs: number;
  superseded_ms: number;
  cancelled_runs: number;
  cancelled_ms: number;
}

interface RoundRow {
  pull_number: number;
  round_index: number;
  sha: string;
  pushed_at: number;
  ended_at: number;
  ms: number;
  red: number;
  commits: number;
  queue_not_recorded: number;
}

interface CheckRow {
  pull_number: number;
  round_index: number;
  position: number;
  name: string;
  attempt: number;
  held_ms: number;
  is_last: number;
  failure: 'red' | 'fluke' | null;
  fluke_ms: number | null;
  queued_ms: number | null;
  detail_not_recorded: number;
  no_file_failed: number;
}

interface FailureRow {
  pull_number: number;
  round_index: number;
  position: number;
  kind: 'step' | 'file';
  item: string;
}

export interface CycleTimeCheck {
  name: string;
  attempt: number;
  heldMs: number;
  last: boolean;
  failure: 'red' | 'fluke' | null;
  flukeMs: number | null;
  queuedMs: number | null;
  failedSteps: string[];
  failedFiles: string[];
}

export interface CycleTimeRound {
  index: number;
  sha: string;
  pushedAt: string;
  endedAt: string;
  ms: number;
  red: boolean;
  commits: number;
  queueNotRecorded: boolean;
  /** The checks that never passed on the commit, by name. */
  failed: string[];
  /** The check that finished the round. */
  last: string | null;
  checks: CycleTimeCheck[];
}

export interface CycleTimePull {
  number: number;
  title: string;
  url: string;
  mergedAt: string;
  base: string;
  head: string | null;
  landing: boolean;
  size: { additions: number; deletions: number; files: number; commits: number; mainMerges: number };
  start: { at: string; from: string };
  recorded: boolean;
  /** Writing against waiting: `codingMs` and `localMs` are null where nobody wrote the time down, which is not zero. */
  time: { codingMs: number | null; localMs: number | null; ciMs: number; waitingToMergeMs: number | null; awayMs: number; totalMs: number };
  /** Null where the time is not recorded or no check ran; `ratio` is null where there was no writing to weigh against. */
  balance: { codingMs: number; harnessMs: number; rounds: number; ratio: number | null } | null;
  localReviews: { count: number; ms: number } | null;
  localRuns: { test: { count: number; ms: number } | null; browser: { count: number; ms: number } | null };
  runnerMs: number;
  cancelled: { superseded: { runs: number; ms: number }; other: { runs: number; ms: number } };
  flukes: { name: string; sha: string; ms: number }[];
  rounds: CycleTimeRound[];
}

export interface Tally {
  attempts: number;
  pulls: { number: number; attempts: number }[];
}

export interface CycleTimeWindow {
  /** Its length in Belgian days, ending today; null for every stored pull request. */
  days: number | null;
  /** The first Belgian day inside it; null for every stored pull request. */
  firstDay: string | null;
  pulls: { total: number; withRecord: number; withoutRecord: number };
  balance: {
    dots: { number: number; codingMs: number; harnessMs: number; rounds: number; ratio: number | null; lines: number }[];
    ratio: Figure | null;
    noChecks: number;
  };
  localReviews: { count: Figure | null; ms: Figure | null };
  rounds: { count: number; red: number; overTenMinutes: number; queueNotRecorded: number; perPull: Figure | null } | null;
  /** Per check: the rounds it ran in, how many it was red in, its flukes and the pull requests they fell on, the minutes it held rounds up, and the rounds it finished last. */
  checks: { name: string; rounds: number; red: number; flukes: number; flukePulls: number; heldMs: number; runs: number; last: number }[];
  queue: Record<string, Figure> | null;
  cancelled: {
    superseded: { runs: number; ms: number };
    other: { runs: number; ms: number };
    runnerMs: number;
    share: number | null;
    supersededShare: number | null;
  } | null;
  failures: {
    attempts: number;
    notRecorded: number;
    noFileFailed: number;
    steps: (Tally & { check: string; step: string })[];
    files: (Tally & { path: string })[];
  };
  flukes: { count: number; pulls: number; ms: number } | null;
}

export interface CycleTimeAnswer {
  period: Period;
  firstDay: string | null;
  windows: CycleTimeWindow[];
  /** Every stored pull request in the period, newest merge first. */
  pulls: CycleTimePull[];
}

interface Stored {
  pull: PullRow;
  rounds: { row: RoundRow; checks: { row: CheckRow; steps: string[]; files: string[] }[] }[];
}

const iso = (ms: number) => new Date(ms).toISOString();

/** Appends `value` to the list under `key`, starting it where there is none. */
function append<K, V>(map: Map<K, V[]>, key: K, value: V) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** Groups the flat rows under their pull request, round and check. */
function assemble(pulls: PullRow[], rounds: RoundRow[], checks: CheckRow[], failures: FailureRow[]): Stored[] {
  const failuresOf = new Map<string, FailureRow[]>();
  for (const f of failures) append(failuresOf, `${f.pull_number}:${f.round_index}:${f.position}`, f);
  const checksOf = new Map<string, CheckRow[]>();
  for (const c of checks) append(checksOf, `${c.pull_number}:${c.round_index}`, c);
  const roundsOf = new Map<number, RoundRow[]>();
  for (const r of rounds) append(roundsOf, r.pull_number, r);

  return pulls.map((pull) => ({
    pull,
    rounds: (roundsOf.get(pull.pull_number) ?? []).map((row) => ({
      row,
      checks: (checksOf.get(`${row.pull_number}:${row.round_index}`) ?? []).map((check) => {
        const own = failuresOf.get(`${check.pull_number}:${check.round_index}:${check.position}`) ?? [];
        return { row: check, steps: own.filter((f) => f.kind === 'step').map((f) => f.item), files: own.filter((f) => f.kind === 'file').map((f) => f.item) };
      }),
    })),
  }));
}

function pullAnswer({ pull: p, rounds }: Stored): CycleTimePull {
  const harnessMs = p.local_ms === null ? null : p.ci_ms + p.local_ms;
  return {
    number: p.pull_number,
    title: p.title,
    url: p.url,
    mergedAt: iso(p.merged_at),
    base: p.base,
    head: p.head,
    landing: p.landing === 1,
    size: { additions: p.additions, deletions: p.deletions, files: p.changed_files, commits: p.commits, mainMerges: p.main_merges },
    start: { at: iso(p.started_at), from: p.start_from },
    recorded: p.recorded === 1,
    time: { codingMs: p.coding_ms, localMs: p.local_ms, ciMs: p.ci_ms, waitingToMergeMs: p.waiting_to_merge_ms, awayMs: p.away_ms, totalMs: p.total_ms },
    balance:
      p.coding_ms === null || harnessMs === null
        ? null
        : { codingMs: p.coding_ms, harnessMs, rounds: rounds.length, ratio: ratioOf(harnessMs, p.coding_ms) },
    localReviews: p.review_count === null ? null : { count: p.review_count, ms: p.review_ms ?? 0 },
    localRuns: {
      test: p.test_runs === null ? null : { count: p.test_runs, ms: p.test_ms ?? 0 },
      browser: p.browser_runs === null ? null : { count: p.browser_runs, ms: p.browser_ms ?? 0 },
    },
    runnerMs: p.runner_ms,
    cancelled: { superseded: { runs: p.superseded_runs, ms: p.superseded_ms }, other: { runs: p.cancelled_runs, ms: p.cancelled_ms } },
    flukes: rounds.flatMap((r) => r.checks.filter((c) => c.row.fluke_ms !== null).map((c) => ({ name: c.row.name, sha: r.row.sha, ms: c.row.fluke_ms! }))),
    rounds: rounds.map(({ row, checks }) => ({
      index: row.round_index,
      sha: row.sha,
      pushedAt: iso(row.pushed_at),
      endedAt: iso(row.ended_at),
      ms: row.ms,
      red: row.red === 1,
      commits: row.commits,
      queueNotRecorded: row.queue_not_recorded === 1,
      failed: [...new Set(checks.filter((c) => c.row.failure === 'red').map((c) => c.row.name))],
      last: checks.find((c) => c.row.is_last === 1)?.row.name ?? null,
      checks: checks.map(({ row: c, steps, files }) => ({
        name: c.name,
        attempt: c.attempt,
        heldMs: c.held_ms,
        last: c.is_last === 1,
        failure: c.failure,
        flukeMs: c.fluke_ms,
        queuedMs: c.queued_ms,
        failedSteps: steps,
        failedFiles: files,
      })),
    })),
  };
}

/** Each step and each test file that failed an attempt in these pull requests, with the pull requests it failed on and how many attempts it failed there. */
function failuresOfWindow(inWindow: Stored[]): CycleTimeWindow['failures'] {
  const attempts = inWindow.flatMap(({ pull, rounds }) => rounds.flatMap((r) => r.checks.filter((c) => c.row.failure !== null).map((c) => ({ pull: pull.pull_number, ...c }))));

  const tally = <T extends { key: string }>(keyed: (T & { pull: number })[]) => {
    const groups = new Map<string, { rest: T; pulls: Map<number, number> }>();
    for (const { pull, ...rest } of keyed) {
      if (!groups.has(rest.key)) groups.set(rest.key, { rest: rest as unknown as T, pulls: new Map() });
      const pulls = groups.get(rest.key)!.pulls;
      pulls.set(pull, (pulls.get(pull) ?? 0) + 1);
    }
    return [...groups.values()].map(({ rest, pulls }) => {
      const { key: _key, ...fields } = rest;
      return {
        ...fields,
        attempts: sum([...pulls.values()]),
        pulls: [...pulls].map(([number, count]) => ({ number, attempts: count })).sort((a, b) => a.number - b.number),
      };
    });
  };
  const byWorst = <T extends Tally>(a: T, b: T) => b.pulls.length - a.pulls.length || b.attempts - a.attempts;

  return {
    attempts: attempts.length,
    notRecorded: attempts.filter((a) => a.row.detail_not_recorded === 1).length,
    noFileFailed: attempts.filter((a) => a.row.no_file_failed === 1).length,
    steps: tally(attempts.flatMap((a) => a.steps.map((step) => ({ key: `${a.row.name}\n${step}`, pull: a.pull, check: a.row.name, step }))))
      .sort((a, b) => byWorst(a, b) || a.check.localeCompare(b.check) || a.step.localeCompare(b.step)),
    files: tally(attempts.flatMap((a) => a.files.map((path) => ({ key: path, pull: a.pull, path }))))
      .sort((a, b) => byWorst(a, b) || a.path.localeCompare(b.path)),
  };
}

/** One window's picture: the pull requests merged in it, as the tool's model reports a window. A feature branch landing is shown but is in no figure: its units are already counted. */
function windowAnswer(stored: Stored[], { days, firstDay }: { days: number | null; firstDay: string | null }): CycleTimeWindow {
  const from = firstDay === null ? 0 : startOfDay(firstDay);
  const inWindow = stored.filter(({ pull }) => pull.landing === 0 && pull.merged_at >= from);
  const rounds = inWindow.flatMap(({ pull, rounds: own }) => own.map((round) => ({ pull: pull.pull_number, round })));
  const withRecord = inWindow.filter(({ pull }) => pull.recorded === 1);
  const placed = inWindow.filter(({ pull }) => pull.coding_ms !== null && pull.local_ms !== null);
  const reviewed = inWindow.filter(({ pull }) => pull.review_count !== null);
  const dots = placed.map((s) => ({
    number: s.pull.pull_number,
    codingMs: s.pull.coding_ms!,
    harnessMs: s.pull.ci_ms + s.pull.local_ms!,
    rounds: s.rounds.length,
    ratio: ratioOf(s.pull.ci_ms + s.pull.local_ms!, s.pull.coding_ms!),
    lines: s.pull.additions + s.pull.deletions,
  }));

  const checkRows = rounds.flatMap(({ pull, round }) => round.checks.map((check) => ({ pull, round: round.row.round_index, ...check })));
  const names = [...new Set(checkRows.map((c) => c.row.name))].sort((a, b) => a.localeCompare(b));
  const queued = new Map<string, { pull: number; value: number }[]>();
  for (const c of checkRows) {
    if (c.row.queued_ms === null) continue;
    append(queued, c.row.name, { pull: c.pull, value: c.row.queued_ms });
  }

  const superseded = { runs: sum(inWindow.map(({ pull }) => pull.superseded_runs)), ms: sum(inWindow.map(({ pull }) => pull.superseded_ms)) };
  const other = { runs: sum(inWindow.map(({ pull }) => pull.cancelled_runs)), ms: sum(inWindow.map(({ pull }) => pull.cancelled_ms)) };
  const runnerMs = sum(inWindow.map(({ pull }) => pull.runner_ms));
  const flukeRows = checkRows.filter((c) => c.row.fluke_ms !== null);

  return {
    days,
    firstDay,
    pulls: { total: inWindow.length, withRecord: withRecord.length, withoutRecord: inWindow.length - withRecord.length },
    balance: {
      dots,
      ratio: figure(dots.flatMap((d) => (d.ratio === null ? [] : [{ pull: d.number, value: d.ratio }]))),
      noChecks: withRecord.length - placed.length,
    },
    localReviews: {
      count: figure(reviewed.map(({ pull }) => ({ pull: pull.pull_number, value: pull.review_count! }))),
      ms: figure(reviewed.map(({ pull }) => ({ pull: pull.pull_number, value: pull.review_ms ?? 0 }))),
    },
    rounds: inWindow.length
      ? {
          count: rounds.length,
          red: rounds.filter(({ round }) => round.row.red === 1).length,
          overTenMinutes: rounds.filter(({ round }) => round.row.ms > LONG_ROUND_MS).length,
          queueNotRecorded: rounds.filter(({ round }) => round.row.queue_not_recorded === 1).length,
          // A pull request no check ever ran on has no round, so it is left out of the rounds it took rather than counted as taking none.
          perPull: figure(inWindow.filter((s) => s.rounds.length > 0).map((s) => ({ pull: s.pull.pull_number, value: s.rounds.length }))),
        }
      : null,
    checks: names.map((name) => {
      const own = checkRows.filter((c) => c.row.name === name);
      const roundKey = (c: (typeof own)[number]) => `${c.pull}:${c.round}`;
      const flukes = own.filter((c) => c.row.fluke_ms !== null);
      return {
        name,
        rounds: new Set(own.map(roundKey)).size,
        red: new Set(own.filter((c) => c.row.failure === 'red').map(roundKey)).size,
        flukes: flukes.length,
        flukePulls: new Set(flukes.map((c) => c.pull)).size,
        heldMs: sum(own.map((c) => c.row.held_ms)),
        runs: own.length,
        last: own.filter((c) => c.row.is_last === 1).length,
      };
    }),
    queue: queued.size === 0 ? null : Object.fromEntries([...queued].sort(([a], [b]) => a.localeCompare(b)).map(([name, entries]) => [name, figure(entries)!])),
    cancelled: inWindow.length
      ? {
          superseded,
          other,
          runnerMs,
          share: runnerMs > 0 ? (superseded.ms + other.ms) / runnerMs : null,
          supersededShare: runnerMs > 0 ? superseded.ms / runnerMs : null,
        }
      : null,
    failures: failuresOfWindow(inWindow),
    flukes: rounds.length
      ? { count: flukeRows.length, pulls: new Set(flukeRows.map((c) => c.pull)).size, ms: sum(flukeRows.map((c) => c.row.fluke_ms!)) }
      : null,
  };
}

/** What the Monitor's own cost totals hold for one pull request, joined through its branch links. */
export interface PullCost {
  /** Priced requests only, in millionths of a dollar. */
  micros: number;
  /** Zero where no request was recorded for it, which is no figure, never $0.00. */
  requests: number;
  unpricedRequests: number;
  /** The issue its link names. */
  issue: number | null;
}

/** What the cycle time page draws: the pull requests merged from a time on with their rounds and checks, what each cost, and the oldest merge stored. */
export interface CycleTimeView {
  pulls: CycleTimePull[];
  costs: Map<number, PullCost>;
  oldest: number | null;
}

/**
 * The pull requests merged from `from` on, newest first, with the cost of each:
 * one batch, so a view is one round trip. The failing steps and files are left
 * out, since the page draws none.
 */
export async function cycleTimeView(db: D1Database, from: number): Promise<CycleTimeView> {
  const [pulls, rounds, checks, costs, oldest] = await db.batch([
    db.prepare('SELECT * FROM cycle_time_pulls WHERE merged_at >= ?1 ORDER BY merged_at DESC, pull_number DESC').bind(from),
    db.prepare(
      `SELECT r.* FROM cycle_time_rounds r JOIN cycle_time_pulls p ON p.pull_number = r.pull_number
       WHERE p.merged_at >= ?1 ORDER BY r.pull_number, r.round_index`,
    ).bind(from),
    db.prepare(
      `SELECT c.* FROM cycle_time_checks c JOIN cycle_time_pulls p ON p.pull_number = c.pull_number
       WHERE p.merged_at >= ?1 ORDER BY c.pull_number, c.round_index, c.position`,
    ).bind(from),
    db.prepare(
      `SELECT l.pr_number AS pr, MAX(l.issue_number) AS issue, COALESCE(SUM(t.cost_micros), 0) AS micros,
              COALESCE(SUM(t.requests), 0) AS requests, COALESCE(SUM(t.unpriced_requests), 0) AS unpriced
       FROM cycle_time_pulls p JOIN branch_links l ON l.pr_number = p.pull_number
       LEFT JOIN daily_split_totals t ON t.branch = l.branch
       WHERE p.merged_at >= ?1 GROUP BY l.pr_number`,
    ).bind(from),
    db.prepare('SELECT MIN(merged_at) AS oldest FROM cycle_time_pulls'),
  ]);
  const stored = assemble(pulls!.results as unknown as PullRow[], rounds!.results as unknown as RoundRow[], checks!.results as unknown as CheckRow[], []);
  return {
    pulls: stored.map(pullAnswer),
    costs: new Map(
      (costs!.results as unknown as { pr: number; issue: number | null; micros: number; requests: number; unpriced: number }[]).map((r) => [
        r.pr,
        { micros: r.micros, requests: r.requests, unpricedRequests: r.unpriced, issue: r.issue },
      ]),
    ),
    oldest: (oldest!.results[0] as { oldest: number | null } | undefined)?.oldest ?? null,
  };
}

/**
 * The stored pull requests for a period: each window up to it, the shortest
 * first, and every pull request merged in it with its rounds and checks. A
 * window starts at the beginning of its first Belgian day.
 */
export async function cycleTimeAnswer(db: D1Database, period: Period, now: number): Promise<CycleTimeAnswer> {
  const length = PERIODS[period];
  const today = belgianDay(now);
  const spans: { days: number | null; firstDay: string | null }[] = [
    ...WINDOW_DAYS.filter((days) => length === null || days <= length).map((days) => ({ days, firstDay: addDays(today, -(days - 1)) })),
    ...(length === null ? [{ days: null, firstDay: null }] : []),
  ];
  const widest = spans.at(-1)!;
  const from = widest.firstDay === null ? 0 : startOfDay(widest.firstDay);

  const [pulls, rounds, checks, failures] = await db.batch([
    db.prepare('SELECT * FROM cycle_time_pulls WHERE merged_at >= ?1 ORDER BY merged_at DESC, pull_number DESC').bind(from),
    db.prepare(
      `SELECT r.* FROM cycle_time_rounds r JOIN cycle_time_pulls p ON p.pull_number = r.pull_number
       WHERE p.merged_at >= ?1 ORDER BY r.pull_number, r.round_index`,
    ).bind(from),
    db.prepare(
      `SELECT c.* FROM cycle_time_checks c JOIN cycle_time_pulls p ON p.pull_number = c.pull_number
       WHERE p.merged_at >= ?1 ORDER BY c.pull_number, c.round_index, c.position`,
    ).bind(from),
    db.prepare(
      `SELECT f.* FROM cycle_time_failures f JOIN cycle_time_pulls p ON p.pull_number = f.pull_number
       WHERE p.merged_at >= ?1 ORDER BY f.pull_number, f.round_index, f.position, f.kind, f.item_index`,
    ).bind(from),
  ]);
  const stored = assemble(pulls!.results as unknown as PullRow[], rounds!.results as unknown as RoundRow[], checks!.results as unknown as CheckRow[], failures!.results as unknown as FailureRow[]);

  return { period, firstDay: widest.firstDay, windows: spans.map((span) => windowAnswer(stored, span)), pulls: stored.map(pullAnswer) };
}
