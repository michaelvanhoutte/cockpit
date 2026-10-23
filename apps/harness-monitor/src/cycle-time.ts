/**
 * Cycle time's merged pull requests as the nightly `Cycle time` job sends them
 * (tools/cycle-time): each with its time split, the rounds of checks it took and
 * every check that held a round, already cut by the tool. The Monitor checks
 * their shape and stores them; it derives nothing, so a pull request with no
 * session record arrives with its writing and local time null, and stays null.
 */

/** Most pull requests one send may carry. The body is capped too, at the Worker's MAX_BODY characters. */
export const MAX_PULLS = 50;
/** Most rounds in one pull request, checks in one round, and steps or files on one failed attempt: far above any real one, so only a malformed send reaches them. */
export const MAX_ROUNDS = 100;
export const MAX_CHECKS = 200;
export const MAX_ITEMS = 500;

export interface CycleCheck {
  name: string;
  attempt: number;
  heldMs: number;
  last: boolean;
  failure: 'red' | 'fluke' | null;
  flukeMs: number | null;
  queuedMs: number | null;
  detailNotRecorded: boolean;
  noFileFailed: boolean;
  failedSteps: string[];
  failedFiles: string[];
}

export interface CycleRound {
  sha: string;
  pushedAt: number;
  endedAt: number;
  ms: number;
  red: boolean;
  commits: number;
  queueNotRecorded: boolean;
  checks: CycleCheck[];
}

export interface Counted {
  count: number;
  ms: number;
}

export interface Cancelled {
  runs: number;
  ms: number;
}

export interface CyclePull {
  number: number;
  title: string;
  url: string;
  mergedAt: number;
  base: string;
  head: string | null;
  landing: boolean;
  size: { additions: number; deletions: number; files: number; commits: number; mainMerges: number };
  startedAt: number;
  startFrom: 'session-record' | 'first-commit';
  recorded: boolean;
  codingMs: number | null;
  localMs: number | null;
  ciMs: number;
  waitingToMergeMs: number | null;
  awayMs: number;
  totalMs: number;
  localReviews: Counted | null;
  localTests: Counted | null;
  localBrowser: Counted | null;
  runnerMs: number;
  superseded: Cancelled;
  cancelled: Cancelled;
  rounds: CycleRound[];
}

export type CheckedPulls = { ok: true; pulls: CyclePull[] } | { ok: false; error: string };

/** A four-digit year and an explicit zone, as GitHub writes every time. */
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const SHA = /^[0-9a-f]{7,64}$/;

type Fields = Record<string, unknown>;

const isObject = (value: unknown): value is Fields => typeof value === 'object' && value !== null && !Array.isArray(value);

function text(value: unknown, max: number, { empty = false } = {}): string | null {
  return typeof value === 'string' && (empty || value.trim() !== '') && value.length <= max ? value : null;
}

/** A required whole number, `min` or more; or, for `nullable`, null where it is absent. A string is the complaint. */
function whole(r: Fields, key: string, options?: { min?: number; nullable?: false }): number | string;
function whole(r: Fields, key: string, options: { min?: number; nullable: true }): number | null | string;
function whole(r: Fields, key: string, { min = 0, nullable = false }: { min?: number; nullable?: boolean } = {}): number | null | string {
  const value = r[key];
  if (value === undefined && !nullable) return `has no ${key}.`;
  if (value === null || value === undefined) return nullable ? null : `has no ${key}.`;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= min) return value;
  return `has ${key} ${JSON.stringify(value)}, which is not a whole number${key.endsWith('Ms') || key === 'ms' ? ' of milliseconds' : ''}, ${min === 0 ? 'zero' : 'one'} or more.`;
}

function flag(r: Fields, key: string): boolean | string {
  return typeof r[key] === 'boolean' ? (r[key] as boolean) : `has ${key} ${JSON.stringify(r[key] ?? null)}, which is not true or false.`;
}

/** A time GitHub wrote, as epoch milliseconds. */
function time(r: Fields, key: string): number | string {
  const value = r[key];
  const ms = typeof value === 'string' && ISO_TIME.test(value) ? Date.parse(value) : Number.NaN;
  return Number.isNaN(ms) ? `has a ${key} that is not an ISO 8601 timestamp with a time zone.` : ms;
}

function shortText(r: Fields, key: string, max: number, { empty = false } = {}): string | null {
  return text(r[key], max, { empty });
}

/** A list of short strings, or the complaint. */
function strings(r: Fields, key: string): string[] | string {
  const list = r[key];
  if (!Array.isArray(list)) return `has no list of ${key}.`;
  if (list.length > MAX_ITEMS) return `has ${list.length} ${key}; the most one attempt takes is ${MAX_ITEMS}.`;
  const items: string[] = [];
  for (const item of list) {
    const checked = text(item, 500, { empty: true });
    if (checked === null) return `has a ${key} entry that is not a short string.`;
    items.push(checked);
  }
  return items;
}

/** `{count, ms}` or null for a kind of local time the record has none of; a string is the complaint. */
function counted(value: unknown, label: string): Counted | null | string {
  if (value === null || value === undefined) return null;
  if (!isObject(value)) return `has ${label} that is not an object.`;
  const count = whole(value, 'count');
  if (typeof count === 'string') return `${label} ${count}`;
  const ms = whole(value, 'ms');
  if (typeof ms === 'string') return `${label} ${ms}`;
  return { count: count, ms: ms };
}

function cancelledOf(value: unknown, label: string): Cancelled | string {
  if (!isObject(value)) return `has no ${label}.`;
  const runs = whole(value, 'runs');
  if (typeof runs === 'string') return `${label} ${runs}`;
  const ms = whole(value, 'ms');
  if (typeof ms === 'string') return `${label} ${ms}`;
  return { runs: runs, ms: ms };
}

function checkCheck(raw: unknown): CycleCheck | string {
  if (!isObject(raw)) return 'is not an object.';
  const name = shortText(raw, 'name', 300);
  if (!name) return 'has no name.';
  const attempt = whole(raw, 'attempt', { min: 1 });
  if (typeof attempt === 'string') return attempt;
  const heldMs = whole(raw, 'heldMs');
  if (typeof heldMs === 'string') return heldMs;
  const last = flag(raw, 'last');
  if (typeof last === 'string') return last;
  const failure = raw.failure ?? null;
  if (failure !== null && failure !== 'red' && failure !== 'fluke') return `has failure ${JSON.stringify(failure)}, which is not red, fluke or null.`;
  const flukeMs = whole(raw, 'flukeMs', { nullable: true });
  if (typeof flukeMs === 'string') return flukeMs;
  const queuedMs = whole(raw, 'queuedMs', { nullable: true });
  if (typeof queuedMs === 'string') return queuedMs;
  const detailNotRecorded = flag(raw, 'detailNotRecorded');
  if (typeof detailNotRecorded === 'string') return detailNotRecorded;
  const noFileFailed = flag(raw, 'noFileFailed');
  if (typeof noFileFailed === 'string') return noFileFailed;
  const failedSteps = strings(raw, 'failedSteps');
  if (typeof failedSteps === 'string') return failedSteps;
  const failedFiles = strings(raw, 'failedFiles');
  if (typeof failedFiles === 'string') return failedFiles;
  if (failure === null && (failedSteps.length > 0 || failedFiles.length > 0 || flukeMs !== null)) return 'names failed steps, files or a fluke, though it did not fail.';
  return { name, attempt, heldMs, last, failure, flukeMs, queuedMs, detailNotRecorded, noFileFailed, failedSteps, failedFiles };
}

function checkRound(raw: unknown): CycleRound | string {
  if (!isObject(raw)) return 'is not an object.';
  const sha = typeof raw.sha === 'string' && SHA.test(raw.sha) ? raw.sha : null;
  if (!sha) return 'has a sha that is not a commit hash.';
  const pushedAt = time(raw, 'pushedAt');
  if (typeof pushedAt === 'string') return pushedAt;
  const endedAt = time(raw, 'endedAt');
  if (typeof endedAt === 'string') return endedAt;
  const ms = whole(raw, 'ms');
  if (typeof ms === 'string') return ms;
  const red = flag(raw, 'red');
  if (typeof red === 'string') return red;
  const commits = whole(raw, 'commits', { min: 1 });
  if (typeof commits === 'string') return commits;
  const queueNotRecorded = flag(raw, 'queueNotRecorded');
  if (typeof queueNotRecorded === 'string') return queueNotRecorded;
  if (!Array.isArray(raw.checks)) return 'has no list of checks.';
  if (raw.checks.length > MAX_CHECKS) return `has ${raw.checks.length} checks; the most one round takes is ${MAX_CHECKS}.`;
  const checks: CycleCheck[] = [];
  for (const [index, rawCheck] of raw.checks.entries()) {
    const check = checkCheck(rawCheck);
    if (typeof check === 'string') {
      const name = isObject(rawCheck) ? text(rawCheck.name, 300) : null;
      return `check ${index}${name ? ` (${name})` : ''} ${check}`;
    }
    checks.push(check);
  }
  return { sha, pushedAt: pushedAt, endedAt: endedAt, ms: ms, red, commits: commits, queueNotRecorded, checks };
}

function checkPull(raw: unknown): CyclePull | string {
  if (!isObject(raw)) return 'is not an object.';
  const number = whole(raw, 'number', { min: 1 });
  if (typeof number === 'string') return number;
  const title = shortText(raw, 'title', 500, { empty: true });
  if (title === null) return 'has no title.';
  const url = shortText(raw, 'url', 500);
  if (!url?.startsWith('https://')) return 'has a url that is not an https address.';
  const mergedAt = time(raw, 'mergedAt');
  if (typeof mergedAt === 'string') return mergedAt;
  const base = shortText(raw, 'base', 300);
  if (!base) return 'has no base.';
  let head: string | null = null;
  if (raw.head !== null && raw.head !== undefined) {
    head = shortText(raw, 'head', 300);
    if (head === null) return 'has a head that is not a short string.';
  }
  const landing = flag(raw, 'landing');
  if (typeof landing === 'string') return landing;
  if (!isObject(raw.size)) return 'has no size.';
  const size = { additions: 0, deletions: 0, files: 0, commits: 0, mainMerges: 0 };
  for (const key of Object.keys(size) as (keyof typeof size)[]) {
    const value = whole(raw.size, key);
    if (typeof value === 'string') return `size ${value}`;
    size[key] = value;
  }
  if (!isObject(raw.start)) return 'has no start.';
  const startedAt = time(raw.start, 'at');
  if (typeof startedAt === 'string') return `start ${startedAt}`;
  const startFrom = raw.start.from;
  if (startFrom !== 'session-record' && startFrom !== 'first-commit') return `start has from ${JSON.stringify(startFrom ?? null)}, which is not session-record or first-commit.`;
  const recorded = flag(raw, 'recorded');
  if (typeof recorded === 'string') return recorded;
  const codingMs = whole(raw, 'codingMs', { nullable: true });
  if (typeof codingMs === 'string') return codingMs;
  const localMs = whole(raw, 'localMs', { nullable: true });
  if (typeof localMs === 'string') return localMs;
  // Time nobody wrote down is not recorded, never a number: a record-less pull request claiming writing time is a tool that disagrees with the Monitor.
  if (!recorded && (codingMs !== null || localMs !== null)) return 'has writing or local time but no session record.';
  const ciMs = whole(raw, 'ciMs');
  if (typeof ciMs === 'string') return ciMs;
  const waitingToMergeMs = whole(raw, 'waitingToMergeMs', { nullable: true });
  if (typeof waitingToMergeMs === 'string') return waitingToMergeMs;
  const awayMs = whole(raw, 'awayMs');
  if (typeof awayMs === 'string') return awayMs;
  const totalMs = whole(raw, 'totalMs');
  if (typeof totalMs === 'string') return totalMs;
  const localReviews = counted(raw.localReviews, 'localReviews');
  if (typeof localReviews === 'string') return localReviews;
  const runs = isObject(raw.localRuns) ? raw.localRuns : {};
  const localTests = counted(runs.test, 'localRuns.test');
  if (typeof localTests === 'string') return localTests;
  const localBrowser = counted(runs.browser, 'localRuns.browser');
  if (typeof localBrowser === 'string') return localBrowser;
  const runnerMs = whole(raw, 'runnerMs');
  if (typeof runnerMs === 'string') return runnerMs;
  if (!isObject(raw.cancelled)) return 'has no cancelled.';
  const superseded = cancelledOf(raw.cancelled.superseded, 'cancelled.superseded');
  if (typeof superseded === 'string') return superseded;
  const cancelled = cancelledOf(raw.cancelled.other, 'cancelled.other');
  if (typeof cancelled === 'string') return cancelled;
  if (!Array.isArray(raw.rounds)) return 'has no list of rounds.';
  if (raw.rounds.length > MAX_ROUNDS) return `has ${raw.rounds.length} rounds; the most one pull request takes is ${MAX_ROUNDS}.`;
  const rounds: CycleRound[] = [];
  for (const [index, rawRound] of raw.rounds.entries()) {
    const round = checkRound(rawRound);
    if (typeof round === 'string') {
      const sha = isObject(rawRound) && typeof rawRound.sha === 'string' ? rawRound.sha.slice(0, 7) : null;
      return `round ${index}${sha ? ` (${sha})` : ''} ${round}`;
    }
    rounds.push(round);
  }
  return {
    number,
    title,
    url,
    mergedAt: mergedAt,
    base,
    head,
    landing,
    size,
    startedAt: startedAt,
    startFrom,
    recorded,
    codingMs,
    localMs,
    ciMs,
    waitingToMergeMs,
    awayMs,
    totalMs,
    localReviews,
    localTests,
    localBrowser,
    runnerMs,
    superseded,
    cancelled,
    rounds,
  };
}

/**
 * Checks a whole send. One bad pull request, round or check refuses all of it,
 * and the error names the pull request by its position and number, and the
 * round and check inside it.
 */
export function checkPulls(body: unknown): CheckedPulls {
  const list = isObject(body) ? body.pulls : undefined;
  if (!Array.isArray(list)) return { ok: false, error: 'The body must be {"pulls": [...]}.' };
  if (list.length === 0) return { ok: false, error: 'The send has no pull requests.' };
  if (list.length > MAX_PULLS) return { ok: false, error: `The send has ${list.length} pull requests; the most one send takes is ${MAX_PULLS}.` };

  const pulls: CyclePull[] = [];
  const seen = new Set<number>();
  for (const [index, raw] of list.entries()) {
    const result = checkPull(raw);
    const number = isObject(raw) && typeof raw.number === 'number' ? raw.number : null;
    const label = `Pull request ${index}${number !== null ? ` (#${number})` : ''}`;
    if (typeof result === 'string') return { ok: false, error: `${label}: ${result}` };
    if (seen.has(result.number)) return { ok: false, error: `${label}: is in the send twice.` };
    seen.add(result.number);
    pulls.push(result);
  }
  return { ok: true, pulls };
}
