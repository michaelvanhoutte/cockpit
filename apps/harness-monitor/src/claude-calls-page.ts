import { formatDay } from './belgium';
import { firstDay, PERIODS, windowsOf, type Period, type Series } from './costs';
import type { JobStatus } from './jobs';

/**
 * What the Cockpit's Claude calls page can be asked, and the figures it answers
 * with ("Show Cockpit's Claude calls on the Harness Monitor", issue 1483). The
 * page reads only `claude_call_daily_totals`, the import's own totals, never the
 * copies: a view's cost follows the number of days on record, not the number of
 * calls.
 */

/** Over time ('day') comes first and is the page the bare address opens. */
export const CALL_GROUPS = ['day', 'feature', 'environment', 'pr', 'startedBy'] as const;
export type CallGroup = (typeof CALL_GROUPS)[number];
export const DEFAULT_CALL_GROUP: CallGroup = 'day';

/** What the dollars are split by: the "where it went" bar, each row's split bar and the $ columns. */
export const CALL_SPLITS = ['environment', 'feature', 'model', 'startedBy'] as const;
export type CallSplit = (typeof CALL_SPLITS)[number];
export const DEFAULT_CALL_SPLIT: CallSplit = 'environment';

/** The environments production's record names, in the order the page lists them. */
export const ENVIRONMENTS = ['production', 'staging', 'ci', 'local'] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

/** A model id as Cockpit records it, and a feature as a slug: never free text. */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:\[\]-]{0,99}$/;
const FEATURE_ID = /^[a-z0-9][a-z0-9-]{0,99}$/;

export interface CallsQuery {
  period: Period;
  environment: Environment | null;
  /** A feature slug, or null for every feature. */
  feature: string | null;
  /** A model id, or null for every model. */
  model: string | null;
  group: CallGroup;
  split: CallSplit;
}

export function parseCallsQuery(params: URLSearchParams): CallsQuery {
  const period = params.get('period') ?? '';
  const group = params.get('group') ?? '';
  const split = params.get('split') ?? '';
  const environment = params.get('environment') ?? '';
  const feature = params.get('feature') ?? '';
  const model = params.get('model') ?? '';
  return {
    // Own keys only: `in` would accept `toString` and the page would throw.
    period: Object.hasOwn(PERIODS, period) ? (period as Period) : '30d',
    environment: (ENVIRONMENTS as readonly string[]).includes(environment) ? (environment as Environment) : null,
    feature: FEATURE_ID.test(feature) ? feature : null,
    model: MODEL_ID.test(model) ? model : null,
    group: (CALL_GROUPS as readonly string[]).includes(group) ? (group as CallGroup) : DEFAULT_CALL_GROUP,
    split: (CALL_SPLITS as readonly string[]).includes(split) ? (split as CallSplit) : DEFAULT_CALL_SPLIT,
  };
}

/** The address of a query, canonical, so the edge cache keys one page one way. */
export function callsQueryString(q: CallsQuery, over: Partial<CallsQuery> = {}): string {
  const all = { ...q, ...over };
  const params = new URLSearchParams();
  if (all.period !== '30d') params.set('period', all.period);
  if (all.environment) params.set('environment', all.environment);
  if (all.feature) params.set('feature', all.feature);
  if (all.model) params.set('model', all.model);
  if (all.group !== DEFAULT_CALL_GROUP) params.set('group', all.group);
  if (all.split !== DEFAULT_CALL_SPLIT) params.set('split', all.split);
  const text = params.toString();
  return text === '' ? '' : `?${text}`;
}

export const ENVIRONMENT_NAMES: Record<Environment, string> = { production: 'Production', staging: 'Staging', ci: 'CI', local: 'Local' };

const FEATURE_NAMES: Record<string, string> = {
  'clean-up-a-note': 'Clean up a note',
  'propose-for-claude': 'Propose for Claude',
  'choose-a-panel': 'Choose a panel',
  'remember-a-sentence': 'Remember a sentence',
  'resolve-a-place': 'Resolve a place',
  'read-what-a-note-means': 'Read what a note means',
  'transcribe-a-recording': 'Transcribe a recording',
};
/** A known feature as the product says it; one this list does not know stays as recorded. */
export const featureName = (slug: string) => FEATURE_NAMES[slug] ?? slug;

/** What started a call, as words: `connector:teams` is Teams, `captured-in-app` is Captured in app, `mcp` is MCP, and none is Not recorded. */
export const startedByName = (value: string) =>
  value === '' ? 'Not recorded' : value === 'mcp' ? 'MCP' : value.replace(/^connector:/, '').replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase());

/** A series of a split as a name. */
export function seriesName(key: string, split: CallSplit): string {
  switch (split) {
    case 'environment':
      return ENVIRONMENT_NAMES[key as Environment] ?? key;
    case 'feature':
      return featureName(key);
    case 'startedBy':
      return startedByName(key);
    case 'model':
      return key;
  }
}

/** One row of a grouping: what it is, and its calls and dollars in total and per series of the split. */
export interface CallGroupRow {
  key: string;
  /** Plain text; the page escapes it. */
  label: string;
  /** The pull request a by-pull-request row is; null for the rest, the row for CI runs on main and the row for every other call included. */
  prNumber: number | null;
  /** The pull request's title where the Monitor has linked it. */
  title: string | null;
  /** How many contract runs a pull request's calls came from; null off the Pull request grouping. */
  runs: number | null;
  /** A catch-all gathers calls nothing names (No pull request): it keeps its row and numbers but draws no split bar. */
  catchAll: boolean;
  calls: number;
  /** Priced calls only. */
  micros: number;
  unpriced: number;
  /** Dollars per series key of the split; a key the row has none of is absent. */
  bySeries: Record<string, number>;
}

export interface CallsPage {
  query: CallsQuery;
  /** Every feature, model and starter on record, for the filters and for each value's colour. */
  features: string[];
  models: string[];
  startedBys: string[];
  groups: CallGroupRow[];
  /** The split's columns, in order. */
  series: Series[];
  /** Per series key, over every row. */
  bySeries: Record<string, number>;
  totalMicros: number;
  calls: number;
  unpriced: number;
  /** Dollars of the period before, in total and per series key; null for all time, which has no before. */
  previous: { micros: number; bySeries: Record<string, number> } | null;
  /** The import's last run, as the costs page shows it. */
  job: JobStatus;
}

/** A value off the database is free text, so dollars per series live in an object with no prototype: no key can be `__proto__`. */
const bag = (): Record<string, number> => Object.create(null) as Record<string, number>;

const SERIES_COLUMN: Record<CallSplit, string> = { environment: 't.environment', feature: 't.feature', model: 't.model', startedBy: 't.started_by' };

/**
 * What a row is grouped under. A pull request row is a CI call with a pull
 * request; CI's other calls are one row (0), and every other call another (-1).
 */
const GROUP_COLUMN: Record<CallGroup, string> = {
  day: 't.day',
  feature: 't.feature',
  environment: 't.environment',
  startedBy: 't.started_by',
  pr: "CASE WHEN t.environment = 'ci' THEN t.pull_request ELSE -1 END",
};

/** The columns the page's labels name, in order, as the totals hold them. */
interface TotalsRow {
  g: string | number;
  s: string;
  calls: number;
  micros: number;
  unpriced: number;
  title: string | null;
}

/** Where a pull request row stands among its siblings: the main row after the numbers, the catch-all last. */
const MAIN = '0';
const NONE = '-1';

/** The columns in series order: the environments in their fixed order, every other split dearest first. */
export function callSeries(split: CallSplit, totals: Record<string, number>): Series[] {
  const keys = Object.keys(totals);
  const ordered =
    split === 'environment'
      ? [...ENVIRONMENTS.filter((e) => keys.includes(e)), ...keys.filter((k) => !(ENVIRONMENTS as readonly string[]).includes(k)).sort()]
      : keys.sort((a, b) => totals[b]! - totals[a]! || seriesName(a, split).localeCompare(seriesName(b, split)));
  return ordered.map((key) => ({ key, label: seriesName(key, split), short: seriesName(key, split) }));
}

/** Sums the totals rows into one row per place of the grouping, in the grouping's order. */
export function groupCalls(rows: TotalsRow[], group: CallGroup, runs: Map<number, number>): CallGroupRow[] {
  const found = new Map<string, CallGroupRow>();
  for (const r of rows) {
    const key = String(r.g);
    let g = found.get(key);
    if (!g) {
      const pr = group === 'pr' && key !== MAIN && key !== NONE ? Number(key) : null;
      const label =
        group === 'day'
          ? formatDay(key)
          : group === 'feature'
            ? featureName(key)
            : group === 'environment'
              ? (ENVIRONMENT_NAMES[key as Environment] ?? key)
              : group === 'startedBy'
                ? startedByName(key)
                : pr !== null
                  ? `#${pr}${r.title ? ` ${r.title}` : ''}`
                  : key === MAIN
                    ? 'Nightly and by-hand runs on main'
                    : 'No pull request';
      g = { key, label, prNumber: pr, title: pr === null ? null : r.title, runs: pr === null ? null : (runs.get(pr) ?? 0), catchAll: group === 'pr' && key === NONE, calls: 0, micros: 0, unpriced: 0, bySeries: bag() };
      found.set(key, g);
    }
    g.calls += r.calls;
    g.micros += r.micros;
    g.unpriced += r.unpriced;
    g.bySeries[r.s] = (g.bySeries[r.s] ?? 0) + r.micros;
  }
  const list = [...found.values()];
  const dearest = (a: CallGroupRow, b: CallGroupRow) => b.micros - a.micros || a.label.localeCompare(b.label);
  switch (group) {
    case 'day':
      return list.sort((a, b) => b.key.localeCompare(a.key));
    case 'environment':
      // Production's four in their fixed order; a name the page does not know after them.
      return list.sort((a, b) => environmentRank(a.key) - environmentRank(b.key) || a.key.localeCompare(b.key));
    case 'pr':
      // Newest first by number, then CI's runs on main, then everything that has no pull request.
      return list.sort((a, b) => rankOf(b) - rankOf(a));
    default:
      return list.sort(dearest);
  }
}

const environmentRank = (key: string) => {
  const at = (ENVIRONMENTS as readonly string[]).indexOf(key);
  return at === -1 ? ENVIRONMENTS.length : at;
};

/** A pull request's number, else -1 for main's row and -2 for the catch-all, so one number orders them all. */
const rankOf = (g: CallGroupRow) => g.prNumber ?? (g.key === MAIN ? -1 : -2);

/** One window's reads: the filters and the span of days, as SQL and its binds. */
function narrowing(query: CallsQuery, from: string | null, to: string | null) {
  const where: string[] = [];
  const binds: (string | number)[] = [];
  if (from !== null) {
    where.push('t.day >= ?');
    binds.push(from);
  }
  if (to !== null) {
    where.push('t.day <= ?');
    binds.push(to);
  }
  if (query.environment !== null) {
    where.push('t.environment = ?');
    binds.push(query.environment);
  }
  if (query.feature !== null) {
    where.push('t.feature = ?');
    binds.push(query.feature);
  }
  if (query.model !== null) {
    where.push('t.model = ?');
    binds.push(query.model);
  }
  return { where, binds };
}

/**
 * Reads the page's figures in one batch from the daily totals: the period's
 * rows under the grouping and the split, the period before it, the values the
 * filters offer, the pull requests' titles (a join, only on that grouping) and
 * contract runs, and the import's last run.
 */
export async function callsPage(db: D1Database, query: CallsQuery, now = Date.now()): Promise<CallsPage> {
  const first = firstDay(query.period, now);
  const windows = windowsOf(query.period, now);
  const current = narrowing(query, first, null);
  const series = SERIES_COLUMN[query.split];
  const conditions = current.where.length === 0 ? '' : `WHERE ${current.where.join(' AND ')}`;
  const titles =
    query.group === 'pr'
      ? ", MAX(l.title) AS title FROM claude_call_daily_totals t LEFT JOIN (SELECT pr_number, MAX(title) AS title FROM branch_links WHERE pr_number IS NOT NULL GROUP BY pr_number) l ON l.pr_number = t.pull_request"
      : ", NULL AS title FROM claude_call_daily_totals t";
  const reads: D1PreparedStatement[] = [
    db
      .prepare(
        `SELECT ${GROUP_COLUMN[query.group]} AS g, ${series} AS s, SUM(t.calls) AS calls, SUM(t.cost_micros) AS micros, SUM(t.unpriced_calls) AS unpriced${titles}
         ${conditions} GROUP BY 1, 2`,
      )
      .bind(...current.binds),
    db.prepare('SELECT feature, model, started_by AS startedBy FROM claude_call_daily_totals GROUP BY feature, model, started_by'),
    db.prepare('SELECT ran_at AS ranAt, started_by AS startedBy, ok, message, last_ok_at AS lastOkAt FROM claude_call_job_runs WHERE job = ?').bind('claude-calls'),
  ];
  if (windows !== null) {
    const before = narrowing(query, windows.previous.from, windows.previous.to);
    reads.push(
      db
        .prepare(`SELECT ${series} AS s, SUM(t.cost_micros) AS micros FROM claude_call_daily_totals t WHERE ${before.where.join(' AND ')} GROUP BY 1`)
        .bind(...before.binds),
    );
  }
  if (query.group === 'pr') {
    // The runs of a pull request that the period's filters keep: the key that lets this count come from the totals alone.
    reads.push(
      db
        .prepare(
          `SELECT t.pull_request AS pr, COUNT(DISTINCT t.run_id) AS runs FROM claude_call_daily_totals t
           ${conditions === '' ? 'WHERE' : `${conditions} AND`} t.environment = 'ci' AND t.pull_request > 0 AND t.run_id > 0 GROUP BY 1`,
        )
        .bind(...current.binds),
    );
  }

  const [rows, options, run, ...rest] = await db.batch(reads);
  const beforeRows = windows === null ? null : rest.shift()!;
  const runCounts = new Map((query.group === 'pr' ? (rest.shift()!.results as { pr: number; runs: number }[]) : []).map((r) => [r.pr, r.runs]));

  const groups = groupCalls(rows!.results as unknown as TotalsRow[], query.group, runCounts);
  const bySeries = bag();
  for (const g of groups) for (const [key, micros] of Object.entries(g.bySeries)) bySeries[key] = (bySeries[key] ?? 0) + micros;
  const known = options!.results as { feature: string; model: string; startedBy: string }[];
  const distinct = (pick: (r: (typeof known)[number]) => string) => [...new Set(known.map(pick))].sort();
  const lastRun = (run!.results[0] ?? null) as { ranAt: number; startedBy: 'schedule' | 'hand'; ok: number; message: string; lastOkAt: number | null } | null;

  const before = bag();
  for (const r of (beforeRows?.results ?? []) as { s: string; micros: number }[]) before[r.s] = r.micros;
  return {
    query,
    features: distinct((r) => r.feature),
    models: distinct((r) => r.model),
    startedBys: distinct((r) => r.startedBy),
    groups,
    series: callSeries(query.split, bySeries),
    bySeries,
    totalMicros: groups.reduce((sum, g) => sum + g.micros, 0),
    calls: groups.reduce((sum, g) => sum + g.calls, 0),
    unpriced: groups.reduce((sum, g) => sum + g.unpriced, 0),
    previous: beforeRows === null ? null : { micros: Object.values(before).reduce((a, b) => a + b, 0), bySeries: before },
    job: {
      job: 'claude-calls',
      run: lastRun ? { ranAt: lastRun.ranAt, startedBy: lastRun.startedBy, ok: lastRun.ok === 1, message: lastRun.message } : null,
      lastSucceededAt: lastRun?.lastOkAt ?? null,
    },
  };
}
