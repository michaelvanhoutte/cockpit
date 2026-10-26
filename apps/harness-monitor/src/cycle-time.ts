/**
 * Cycle time's merged pull requests as the nightly `Cycle time` job sends them
 * (tools/cycle-time): each with its time split, the rounds of checks it took,
 * every check that held a round and its timeline, already cut by the tool; and
 * the backfill's timelines sent alone. The Monitor checks
 * their shape and stores them; it derives nothing, so a pull request with no
 * session record arrives with its writing and local time null, and stays null.
 */

/** Most pull requests one send may carry. The body is capped too, at the Worker's MAX_BODY characters. */
export const MAX_PULLS = 50;
/** Most rounds in one pull request, checks in one round, and steps or files on one failed attempt: far above any real one, so only a malformed send reaches them. */
export const MAX_ROUNDS = 100;
export const MAX_CHECKS = 200;
export const MAX_ITEMS = 500;
/** Most job lanes in one round, and local slices of one kind in one timeline: far above any real one. */
export const MAX_LANES = 300;
export const MAX_SLICES = 1000;

/** What a job ended as, as the tool classifies it. */
export const LANE_OUTCOMES = ['pass', 'fail', 'cancelled', 'skipped', 'running', 'other', 'unknown'] as const;
export type LaneOutcome = (typeof LANE_OUTCOMES)[number];
/** The local runs that are not a review: test runs and the browser pass. */
export const RUN_KINDS = ['test', 'browser'] as const;
export type RunKind = (typeof RUN_KINDS)[number];

/** One CI job that ran in a round: where it started and stopped inside the round, and its wait for a runner before it (`leadMs`, cut at the round's start). */
export interface TimelineLane {
  name: string;
  /** A shard's family and index, or a fan-in's family; absent for a job of neither. */
  family?: string;
  shard?: number;
  fanIn?: true;
  attempt: number;
  rerun: boolean;
  outcome: LaneOutcome;
  startedAt: string;
  endedAt: string | null;
  offsetMs: number;
  ms: number;
  leadMs: number;
  queuedMs: number | null;
}

/** A local review cut to the gap it sat in: `gap` 0 is before the first push, n after round n. */
export interface ReviewSlice {
  kind: ReviewKind;
  level?: string;
  endedTogether?: true;
  gap: number;
  at: string;
  ms: number;
}

/** A test run or the browser pass, cut to its gap as a review is. */
export interface RunSlice {
  kind: RunKind;
  scopes?: string[];
  gap: number;
  at: string;
  ms: number;
}

/**
 * What a pull request's strip needs that its row, rounds and checks do not hold:
 * each round's job lanes, in round order, `null` for a round whose job list was
 * not read; and its local slices.
 */
export interface CycleTimeline {
  lanes: (TimelineLane[] | null)[];
  reviewSlices: ReviewSlice[];
  runSlices: RunSlice[];
}

export interface CycleCheck {
  name: string;
  attempt: number;
  heldMs: number;
  last: boolean;
  failure: 'red' | 'fluke' | null;
  flukeMs: number | null;
  queuedMs: number | null;
  /** The runner time its jobs used, every shard of a family added up; null from a job that does not send it, which is not recorded. */
  runningMs: number | null;
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

/** The local reviews: the combined figure, and each kind's own where the job sent them (null from one that does not, which is not recorded). */
export interface LocalReviews extends Counted {
  byKind: Record<ReviewKind, Counted> | null;
}

export const REVIEW_KINDS = ['code-review', 'security-review'] as const;
export type ReviewKind = (typeof REVIEW_KINDS)[number];

/** The parts of the local time: code review, security review, test runs and the browser pass. */
export const LOCAL_KINDS = [...REVIEW_KINDS, 'test', 'browser'] as const;
export type LocalKind = (typeof LOCAL_KINDS)[number];
/** Each part's milliseconds with every minute counted once, adding up to the local time; the tool decides which part a shared minute goes to. */
export type LocalParts = Record<LocalKind, number>;

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
  localReviews: LocalReviews | null;
  localTests: Counted | null;
  localBrowser: Counted | null;
  /** Null from a job that does not send them, or where `localMs` is null: not split by kind, never zero. */
  localParts: LocalParts | null;
  runnerMs: number;
  superseded: Cancelled;
  cancelled: Cancelled;
  rounds: CycleRound[];
  /** Null where the send carried none: the pull request is then stored without one. */
  timeline: CycleTimeline | null;
}

export type CheckedPulls = { ok: true; pulls: CyclePull[] } | { ok: false; error: string };

/** A timeline sent alone, for a pull request the Monitor already holds. */
export interface TimelineOf {
  number: number;
  timeline: CycleTimeline;
}

export type CheckedTimelines = { ok: true; timelines: TimelineOf[] } | { ok: false; error: string };

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

/** The reviews' count and minutes, with each kind's where sent: both kinds or neither, since a kind the record marked none of is sent as zero. */
function reviewsOf(value: unknown): LocalReviews | null | string {
  const total = counted(value, 'localReviews');
  if (total === null || typeof total === 'string') return total;
  const kinds = (value as Fields).byKind;
  if (kinds === null || kinds === undefined) return { ...total, byKind: null };
  if (!isObject(kinds)) return 'has localReviews.byKind that is not an object.';
  const byKind = {} as Record<ReviewKind, Counted>;
  for (const kind of REVIEW_KINDS) {
    const own = counted(kinds[kind], `localReviews.byKind.${kind}`);
    if (own === null) return `has no localReviews.byKind.${kind}.`;
    if (typeof own === 'string') return own;
    byKind[kind] = own;
  }
  return { ...total, byKind };
}

/**
 * The local time's parts, or null where none were sent. Parts are refused on a pull request with no
 * session record or no local time, and wherever they do not add up to the local time to the millisecond.
 */
function partsOf(value: unknown, recorded: boolean, localMs: number | null): LocalParts | null | string {
  if (value === null || value === undefined) return null;
  if (!isObject(value)) return 'has localParts that is not an object.';
  if (!recorded) return 'has localParts but no session record.';
  if (localMs === null) return 'has localParts but no localMs for them to add up to.';
  const parts = {} as LocalParts;
  for (const kind of LOCAL_KINDS) {
    const ms = value[kind];
    if (ms === undefined || ms === null) return `has no localParts.${kind}.`;
    if (typeof ms !== 'number' || !Number.isSafeInteger(ms) || ms < 0) return `has localParts.${kind} ${JSON.stringify(ms)}, which is not a whole number of milliseconds, zero or more.`;
    parts[kind] = ms;
  }
  const total = LOCAL_KINDS.reduce((sum, kind) => sum + parts[kind], 0);
  if (total !== localMs) return `has localParts adding up to ${total} ms, not its localMs of ${localMs}.`;
  return parts;
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
  const runningMs = whole(raw, 'runningMs', { nullable: true });
  if (typeof runningMs === 'string') return runningMs;
  const detailNotRecorded = flag(raw, 'detailNotRecorded');
  if (typeof detailNotRecorded === 'string') return detailNotRecorded;
  const noFileFailed = flag(raw, 'noFileFailed');
  if (typeof noFileFailed === 'string') return noFileFailed;
  const failedSteps = strings(raw, 'failedSteps');
  if (typeof failedSteps === 'string') return failedSteps;
  const failedFiles = strings(raw, 'failedFiles');
  if (typeof failedFiles === 'string') return failedFiles;
  if (failure === null && (failedSteps.length > 0 || failedFiles.length > 0 || flukeMs !== null)) return 'names failed steps, files or a fluke, though it did not fail.';
  return { name, attempt, heldMs, last, failure, flukeMs, queuedMs, runningMs, detailNotRecorded, noFileFailed, failedSteps, failedFiles };
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

/** A time GitHub wrote, kept as it was written; a string beginning "has" is the complaint. */
function isoText(r: Fields, key: string): { at: string } | string {
  const checked = time(r, key);
  return typeof checked === 'string' ? checked : { at: r[key] as string };
}

function checkLane(raw: unknown): TimelineLane | string {
  if (!isObject(raw)) return 'is not an object.';
  const name = shortText(raw, 'name', 300);
  if (!name) return 'has no name.';
  const lane = { name } as TimelineLane;
  if (raw.family !== undefined && raw.family !== null) {
    const family = shortText(raw, 'family', 300);
    if (!family) return 'has a family that is not a short string.';
    lane.family = family;
  }
  if (raw.shard !== undefined && raw.shard !== null) {
    const shard = whole(raw, 'shard');
    if (typeof shard === 'string') return shard;
    lane.shard = shard;
  }
  if (raw.fanIn !== undefined && raw.fanIn !== null && raw.fanIn !== false) {
    if (raw.fanIn !== true) return `has fanIn ${JSON.stringify(raw.fanIn)}, which is not true or false.`;
    lane.fanIn = true;
  }
  const attempt = whole(raw, 'attempt', { min: 1 });
  if (typeof attempt === 'string') return attempt;
  const rerun = flag(raw, 'rerun');
  if (typeof rerun === 'string') return rerun;
  const outcome = raw.outcome;
  if (!LANE_OUTCOMES.includes(outcome as LaneOutcome)) return `has outcome ${JSON.stringify(outcome ?? null)}, which is not ${LANE_OUTCOMES.join(', ')}.`;
  const startedAt = isoText(raw, 'startedAt');
  if (typeof startedAt === 'string') return startedAt;
  let endedAt: string | null = null;
  if (raw.endedAt !== null && raw.endedAt !== undefined) {
    const ended = isoText(raw, 'endedAt');
    if (typeof ended === 'string') return ended;
    endedAt = ended.at;
  }
  for (const key of ['offsetMs', 'ms', 'leadMs'] as const) {
    const value = whole(raw, key);
    if (typeof value === 'string') return value;
    lane[key] = value;
  }
  const queuedMs = whole(raw, 'queuedMs', { nullable: true });
  if (typeof queuedMs === 'string') return queuedMs;
  return { ...lane, attempt, rerun, outcome: outcome as LaneOutcome, startedAt: startedAt.at, endedAt, queuedMs };
}

/** The gap, start and length every slice has; a string is the complaint. */
function sliceTimes(raw: Fields): { gap: number; at: string; ms: number } | string {
  const gap = whole(raw, 'gap');
  if (typeof gap === 'string') return gap;
  const at = isoText(raw, 'at');
  if (typeof at === 'string') return at;
  const ms = whole(raw, 'ms');
  if (typeof ms === 'string') return ms;
  return { gap, at: at.at, ms };
}

function checkReviewSlice(raw: unknown): ReviewSlice | string {
  if (!isObject(raw)) return 'is not an object.';
  if (!REVIEW_KINDS.includes(raw.kind as ReviewKind)) return `has kind ${JSON.stringify(raw.kind ?? null)}, which is not ${REVIEW_KINDS.join(' or ')}.`;
  const slice = { kind: raw.kind } as ReviewSlice;
  if (raw.level !== undefined && raw.level !== null) {
    const level = shortText(raw, 'level', 100);
    if (!level) return 'has a level that is not a short string.';
    slice.level = level;
  }
  if (raw.endedTogether !== undefined && raw.endedTogether !== null && raw.endedTogether !== false) {
    if (raw.endedTogether !== true) return `has endedTogether ${JSON.stringify(raw.endedTogether)}, which is not true or false.`;
    slice.endedTogether = true;
  }
  const times = sliceTimes(raw);
  return typeof times === 'string' ? times : { ...slice, ...times };
}

function checkRunSlice(raw: unknown): RunSlice | string {
  if (!isObject(raw)) return 'is not an object.';
  if (!RUN_KINDS.includes(raw.kind as RunKind)) return `has kind ${JSON.stringify(raw.kind ?? null)}, which is not ${RUN_KINDS.join(' or ')}.`;
  const slice = { kind: raw.kind } as RunSlice;
  if (raw.scopes !== undefined && raw.scopes !== null) {
    const scopes = strings(raw, 'scopes');
    if (typeof scopes === 'string') return scopes;
    slice.scopes = scopes;
  }
  const times = sliceTimes(raw);
  return typeof times === 'string' ? times : { ...slice, ...times };
}

/** Each of a list of slices checked, or the complaint naming the one that is wrong. */
function slicesOf<T>(raw: Fields, key: 'reviewSlices' | 'runSlices', check: (slice: unknown) => T | string): T[] | string {
  const list = raw[key];
  if (!Array.isArray(list)) return `has no list of ${key}.`;
  if (list.length > MAX_SLICES) return `has ${list.length} ${key}; the most one timeline takes is ${MAX_SLICES}.`;
  const slices: T[] = [];
  for (const [index, rawSlice] of list.entries()) {
    const slice = check(rawSlice);
    if (typeof slice === 'string') return `${key} ${index} ${slice}`;
    slices.push(slice);
  }
  return slices;
}

/** A timeline's own shape, whatever pull request it is for. The complaint follows "timeline". */
function checkTimeline(raw: unknown): CycleTimeline | string {
  if (!isObject(raw)) return 'is not an object.';
  if (!Array.isArray(raw.lanes)) return 'has no list of lanes.';
  if (raw.lanes.length > MAX_ROUNDS) return `has lanes for ${raw.lanes.length} rounds; the most one pull request takes is ${MAX_ROUNDS}.`;
  const lanes: (TimelineLane[] | null)[] = [];
  for (const [index, rawRound] of raw.lanes.entries()) {
    // A round whose job list was not read has no lanes, which is not recorded, never none.
    if (rawRound === null) {
      lanes.push(null);
      continue;
    }
    if (!Array.isArray(rawRound)) return `round ${index} has lanes that are not a list or null.`;
    if (rawRound.length > MAX_LANES) return `round ${index} has ${rawRound.length} lanes; the most one round takes is ${MAX_LANES}.`;
    const own: TimelineLane[] = [];
    for (const [position, rawLane] of rawRound.entries()) {
      const lane = checkLane(rawLane);
      if (typeof lane === 'string') {
        const name = isObject(rawLane) ? text(rawLane.name, 300) : null;
        return `round ${index} lane ${position}${name ? ` (${name})` : ''} ${lane}`;
      }
      own.push(lane);
    }
    lanes.push(own);
  }
  const reviewSlices = slicesOf(raw, 'reviewSlices', checkReviewSlice);
  if (typeof reviewSlices === 'string') return reviewSlices;
  const runSlices = slicesOf(raw, 'runSlices', checkRunSlice);
  if (typeof runSlices === 'string') return runSlices;
  return { lanes, reviewSlices, runSlices };
}

/**
 * Whether a timeline fits a pull request of `rounds` rounds: lanes for each round
 * and no more, and every slice in a gap the pull request has (gap n is after
 * round n, so the last is one before the round count). Null where it fits.
 */
export function timelineMisfit(timeline: CycleTimeline, rounds: number, whose: string): string | null {
  const counted = (n: number) => `${n} round${n === 1 ? '' : 's'}`;
  if (timeline.lanes.length !== rounds) return `has a timeline of ${counted(timeline.lanes.length)}, but ${whose} ${rounds}.`;
  for (const key of ['reviewSlices', 'runSlices'] as const) {
    const index = timeline[key].findIndex((slice) => slice.gap >= rounds);
    if (index >= 0) return `has a timeline whose ${key} ${index} sits in gap ${timeline[key][index]!.gap}, but ${whose} ${counted(rounds)}.`;
  }
  return null;
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
  const localReviews = reviewsOf(raw.localReviews);
  if (typeof localReviews === 'string') return localReviews;
  const runs = isObject(raw.localRuns) ? raw.localRuns : {};
  const localTests = counted(runs.test, 'localRuns.test');
  if (typeof localTests === 'string') return localTests;
  const localBrowser = counted(runs.browser, 'localRuns.browser');
  if (typeof localBrowser === 'string') return localBrowser;
  const localParts = partsOf(raw.localParts, recorded, localMs);
  if (typeof localParts === 'string') return localParts;
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
  // A pull request's running times add up to its runner time only whole, so an attempt without one beside attempts with one is a tool that disagrees with itself.
  const attempts = rounds.flatMap((round) => round.checks);
  const withRunning = attempts.filter((check) => check.runningMs !== null).length;
  if (withRunning > 0 && withRunning < attempts.length) return `has runningMs on ${withRunning} of its ${attempts.length} check attempts; it is sent on all of them or none.`;
  let timeline: CycleTimeline | null = null;
  if (raw.timeline !== null && raw.timeline !== undefined) {
    const checked = checkTimeline(raw.timeline);
    if (typeof checked === 'string') return `timeline ${checked}`;
    const misfit = timelineMisfit(checked, rounds.length, 'it has');
    if (misfit) return misfit;
    timeline = checked;
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
    localParts,
    runnerMs,
    superseded,
    cancelled,
    rounds,
    timeline,
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

/**
 * Checks a timeline-only send's shape: `{"timelines": [{number, timeline}]}`.
 * Whether each fits the pull request it names is the store's to say, since only
 * it holds the rounds. One bad timeline refuses all of it, named as `checkPulls`
 * names a pull request.
 */
export function checkTimelines(body: unknown): CheckedTimelines {
  const list = isObject(body) ? body.timelines : undefined;
  if (!Array.isArray(list)) return { ok: false, error: 'The body must be {"timelines": [...]}.' };
  if (list.length === 0) return { ok: false, error: 'The send has no timelines.' };
  if (list.length > MAX_PULLS) return { ok: false, error: `The send has ${list.length} timelines; the most one send takes is ${MAX_PULLS}.` };

  const timelines: TimelineOf[] = [];
  const seen = new Set<number>();
  for (const [index, raw] of list.entries()) {
    const number = isObject(raw) ? whole(raw, 'number', { min: 1 }) : 'is not an object.';
    const label = `Timeline ${index}${typeof number === 'number' ? ` (#${number})` : ''}`;
    if (typeof number === 'string') return { ok: false, error: `${label}: ${number}` };
    const timeline = checkTimeline((raw as Fields).timeline);
    if (typeof timeline === 'string') return { ok: false, error: `${label}: timeline ${timeline}` };
    if (seen.has(number)) return { ok: false, error: `${label}: is in the send twice.` };
    seen.add(number);
    timelines.push({ number, timeline });
  }
  return { ok: true, timelines };
}
