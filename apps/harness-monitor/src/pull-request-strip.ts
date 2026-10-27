/**
 * The layout of a pull request's strip on its page: which parts it spent, in order, and how
 * much of a time scale each takes. No markup here (src/pull-request-timeline.ts draws what
 * this returns) and no clock, so a test can hand it any pull request.
 *
 *   coding - round - fixing - round - wait - (merge)
 *
 * It is the layout of the static page's strip (tools/cycle-time/src/render/strips.js), ported
 * with one change: local work that overlaps is packed into rows as CI jobs are.
 *
 * The strip is drawn against one scale, the pull request's own up to four hours. Time away
 * (a gap of over three hours, `AWAY_MS`) is not on that scale: it would swallow the strip, and is
 * drawn as a fixed break instead. A strip that still outruns the scale is cut at its edge and says
 * how much it cut. Every part sits at its own time and length on the scale (`fitTo` places them):
 * none is padded, and none pushes another along. A slice too short to see is drawn a little wider
 * by the page, over what follows it, and what follows still starts at its own time.
 */

import { nextRoundTime } from './belgium';
import type { CycleTimeline, ReviewKind, ReviewSlice, RunKind, RunSlice, TimelineLane } from './cycle-time';
import { REVIEW_KINDS, RUN_KINDS } from './cycle-time';
import type { CycleTimePull } from './cycle-time-store';

/** A gap of more than this between one round ending and the next push is time away, as the tool's model counts it. */
export const AWAY_MS = 3 * 3_600_000;

/** A local slice's kind: a review, a test run or the browser pass. */
export type SliceKind = ReviewKind | RunKind;

/** Top to bottom in a stack of parallel lanes: each review, then the test run, then the browser pass. */
const LANE_ORDER: SliceKind[] = [...REVIEW_KINDS, ...RUN_KINDS];

/** The longest stretch of time a strip is drawn to before it is cut. */
const SCALE_CAP_MS = 4 * 3_600_000;

/** Below this a scale would be a scale of nothing, and every part would draw as full width. */
const SCALE_FLOOR_MS = 60_000;

/** The row a lane takes in a stack, by its rank in busyness: 0 is the strip's line, then above (-1), below (1), further above (-2), further below (2)... */
const rowOfRank = (rank: number) => (rank === 0 ? 0 : rank % 2 === 1 ? -(rank + 1) / 2 : rank / 2);

/** What a stretch of time takes in a row: from where it is occupied to where it ends, and the time it keeps the row busy for. */
interface Occupant {
  from: number;
  to: number;
  busy: number;
}

/**
 * Packs occupants, in the order given, into as few rows as ever run at once: each takes the free
 * row that ended last, so one that began where another ended carries on its row. The row that was
 * busiest holds the strip's line, then the next above it, then below, and ties fall to the row
 * opened first, so the same work holds the same rows on every render. Returns each occupant's row
 * on the strip (0 the line, negative above, positive below).
 */
function packRows(occupants: Occupant[]): number[] {
  const rows: { end: number; busy: number }[] = [];
  const packed = occupants.map((each) => {
    // The free row that ended last, so work that began where another ended carries on its row.
    let index = -1;
    rows.forEach((row, at) => {
      if (row.end <= each.from && (index === -1 || row.end > rows[index]!.end)) index = at;
    });
    if (index === -1) index = rows.push({ end: -Infinity, busy: 0 }) - 1;
    rows[index]!.end = each.to;
    rows[index]!.busy += each.busy;
    return index;
  });
  const ranked = rows.map((row, index) => ({ index, busy: row.busy })).sort((a, b) => b.busy - a.busy || a.index - b.index);
  const rowOf = new Map(ranked.map((row, rank) => [row.index, rowOfRank(rank)]));
  return packed.map((index) => rowOf.get(index)!);
}

/** A local slice as the strip says it: its kind, level or scope, when it ran and the length of the whole slice, which a part cut by another slice is shorter than. */
export interface Described {
  type: 'review' | RunKind;
  kind: SliceKind;
  level?: string;
  scopes?: string[];
  endedTogether?: true;
  at: string;
  sliceMs: number;
}

/** One lane of a stretch of parallel local work: where it sits in the stretch, and the row it takes. */
export type LocalLane = Described & { offsetMs: number; ms: number; row: number };

/** A part of a strip, before it is placed on a scale. */
export interface StripPart {
  type: 'coding' | 'fixing' | 'wait' | 'away' | 'round' | 'review' | RunKind | 'parallel';
  ms: number;
  /** A round: its place in the strip's rounds (from 1) and the round itself. */
  round?: StripRound;
  index?: number;
  /** A round's job lanes in rows, or null where they were not recorded. */
  lanes?: PlacedLane[] | LocalLane[] | null;
  /** A parallel stretch: the coding or fixing the line shows where no lane of it runs. */
  base?: 'coding' | 'fixing';
  kind?: SliceKind;
  level?: string;
  scopes?: string[];
  endedTogether?: true;
  at?: string;
  sliceMs?: number;
}

/** A part placed on a scale: where it starts (the time before it, not counting time away) and how many breaks sit before it. */
export type PlacedPart = StripPart & { startMs: number; breaksBefore: number; cut?: true };

/** A round's job lane in its row. */
export type PlacedLane = TimelineLane & { row: number };

/** One round of a strip, with what its page text and pieces need. */
export interface StripRound {
  pushedAt: string;
  endedAt: string;
  ms: number;
  red: boolean;
  /** The checks that never passed on the commit, by name. */
  failed: string[];
  flukes: { name: string; ms: number }[];
  /** Every check that held the round, in the order it did; `rerun` on one that an earlier attempt of the same check preceded. */
  held: { name: string; ms: number; rerun?: true }[];
  lanes: TimelineLane[] | null;
}

/** What the strip is laid out from: a stored pull request with its timeline. */
export interface StripPull {
  number: number;
  recorded: boolean;
  /** From the session's start (the first commit where there is no record) to the first push. */
  beforeFirstPushMs: number;
  mergedAt: string;
  totalMs: number;
  rounds: StripRound[];
  reviewSlices: ReviewSlice[];
  runSlices: RunSlice[];
  notes: string[];
}

/** The note a pull request with no session record carries, as the tool's model words it. */
const NO_RECORD_NOTE = 'No session record: the time starts at the first commit, so any coding before it and the local reviews are not recorded.';

/**
 * A stored pull request and its timeline as the strip is laid out from. The rounds' checks become what held each
 * round, its failed checks and its flukes, as the Monitor's rows hold them; the session's start is the stored start.
 */
export function stripOf(pull: CycleTimePull, timeline: CycleTimeline): StripPull {
  const rounds = pull.rounds.map((round, position): StripRound => {
    const seen = new Set<string>();
    const held = round.checks.map((check) => {
      const rerun = seen.has(check.name);
      seen.add(check.name);
      return { name: check.name, ms: check.heldMs, ...(rerun ? { rerun: true as const } : {}) };
    });
    return {
      pushedAt: round.pushedAt,
      endedAt: round.endedAt,
      ms: round.ms,
      red: round.red,
      failed: round.failed,
      flukes: round.checks.filter((check) => check.flukeMs !== null).map((check) => ({ name: check.name, ms: check.flukeMs! })),
      held,
      // A round with an empty list of jobs reads as one whose jobs were not recorded, as the tool's own model does.
      lanes: timeline.lanes[position]?.length ? timeline.lanes[position] : null,
    };
  });
  const firstPush = rounds[0] ? Date.parse(rounds[0].pushedAt) : 0;
  return {
    number: pull.number,
    recorded: pull.recorded,
    beforeFirstPushMs: rounds[0] ? Math.max(0, firstPush - Date.parse(pull.start.at)) : 0,
    mergedAt: pull.mergedAt,
    totalMs: pull.time.totalMs,
    rounds,
    reviewSlices: timeline.reviewSlices,
    runSlices: timeline.runSlices,
    notes: pull.recorded ? [] : [NO_RECORD_NOTE],
  };
}

/** A local slice with the gap it sat in; `gap` 0 is before the first push, n after round n. */
type Slice = (ReviewSlice | RunSlice) & { gap: number };

/** What a strip says of one local slice. */
function describe(slice: Slice): Described {
  return {
    type: (REVIEW_KINDS as readonly string[]).includes(slice.kind) ? 'review' : (slice.kind as RunKind),
    kind: slice.kind,
    ...('level' in slice && slice.level ? { level: slice.level } : {}),
    ...('scopes' in slice && slice.scopes ? { scopes: slice.scopes } : {}),
    ...('endedTogether' in slice && slice.endedTogether ? { endedTogether: true as const } : {}),
    at: slice.at,
    sliceMs: slice.ms,
  };
}

/**
 * One gap of writing, before the first push or between rounds, as the stretches of `type` and the
 * local work that sat in it, in the order it ran. The slices are cut to the gap, so what is left of
 * `type` is the gap's length less them, and the strip adds up to the same minutes the scatter's
 * harness does. Slices that overlap are one `parallel` part holding a lane per slice, packed into as
 * few rows as ever run at once.
 */
function gapParts(type: 'coding' | 'fixing', from: number, to: number, slices: Slice[]): StripPart[] {
  const ranges = slices
    .map((slice) => ({ slice, from: Math.max(from, Date.parse(slice.at)), to: Math.min(to, Date.parse(slice.at) + slice.ms) }))
    .filter((range) => range.to > range.from)
    .sort((a, b) => a.from - b.from || a.to - b.to);
  // Slices that overlap, directly or through a chain of them, are one stretch of parallel work.
  const stretches: { from: number; to: number; ranges: typeof ranges }[] = [];
  for (const range of ranges) {
    const last = stretches[stretches.length - 1];
    if (last && range.from < last.to) {
      last.ranges.push(range);
      last.to = Math.max(last.to, range.to);
    } else stretches.push({ from: range.from, to: range.to, ranges: [range] });
  }

  const parts: StripPart[] = [];
  let cursor = from;
  for (const stretch of stretches) {
    if (stretch.from > cursor) parts.push({ type, ms: stretch.from - cursor });
    if (stretch.ranges.length === 1) parts.push({ ...describe(stretch.ranges[0]!.slice), ms: stretch.to - stretch.from });
    else {
      const lanes = stretch.ranges.map((range) => ({ ...describe(range.slice), offsetMs: range.from - stretch.from, ms: range.to - range.from }));
      // Packed in the order the work began, the fixed order breaking a tie, so the same work holds the same rows on every render.
      const byStart = [...lanes].sort((a, b) => a.offsetMs - b.offsetMs || a.offsetMs + a.ms - (b.offsetMs + b.ms) || LANE_ORDER.indexOf(a.kind) - LANE_ORDER.indexOf(b.kind));
      const rows = packRows(byStart.map((lane) => ({ from: lane.offsetMs, to: lane.offsetMs + lane.ms, busy: lane.ms })));
      const rowOf = new Map(byStart.map((lane, at) => [lane, rows[at]!]));
      // One lane per thread, in the fixed order; each sits where its own work does, so a lane that ends early leaves the rest of the stretch to the others.
      const placed: LocalLane[] = lanes
        .map((lane) => ({ ...lane, row: rowOf.get(lane)! }))
        .sort((a, b) => LANE_ORDER.indexOf(a.kind) - LANE_ORDER.indexOf(b.kind) || a.offsetMs - b.offsetMs);
      // `base` is what the line shows where no lane of it is running: the coding or fixing the stretch sat in.
      parts.push({ type: 'parallel', base: type, ms: stretch.to - stretch.from, lanes: placed });
    }
    cursor = stretch.to;
  }
  if (to > cursor) parts.push({ type, ms: to - cursor });
  return parts;
}

/**
 * A round's jobs placed in rows: a job takes the free row that ended last, from its lead's start to
 * its end, so jobs that overlapped sit in different rows and one that waited on another sits in
 * its row after it. The row that was busiest holds the strip's line, then the next above it, then
 * below, so the same jobs hold the same rows on every render. Null where the round's jobs are not recorded.
 */
export function placeLanes(lanes: TimelineLane[] | null | undefined): PlacedLane[] | null {
  if (!Array.isArray(lanes)) return null;
  const rows = packRows(lanes.map((lane) => ({ from: lane.offsetMs - lane.leadMs, to: lane.offsetMs + lane.ms, busy: lane.leadMs + lane.ms })));
  return lanes.map((lane, at) => ({ ...lane, row: rows[at]! }));
}

/**
 * A pull request's parts, in the order they were spent. Empty where no check ever ran on it, since
 * every part after the first push is measured from a round.
 */
export function partsOf(pull: StripPull): StripPart[] {
  const parts: StripPart[] = [];
  if (pull.rounds.length === 0) return parts;
  const slicesIn = (gap: number): Slice[] => [...pull.reviewSlices, ...pull.runSlices].filter((slice) => slice.gap === gap);

  const firstPush = Date.parse(pull.rounds[0]!.pushedAt);
  parts.push(...gapParts('coding', firstPush - pull.beforeFirstPushMs, firstPush, slicesIn(0)));
  pull.rounds.forEach((round, position) => {
    parts.push({ type: 'round', ms: round.ms, round, index: position + 1, lanes: placeLanes(round.lanes) });
    const next = pull.rounds[position + 1];
    const from = Date.parse(round.endedAt);
    const to = Date.parse(next ? next.pushedAt : pull.mergedAt);
    const gap = Math.max(0, to - from);
    if (gap > AWAY_MS) parts.push({ type: 'away', ms: gap });
    else if (next) parts.push(...gapParts('fixing', from, to, slicesIn(position + 1)));
    else if (gap > 0) parts.push({ type: 'wait', ms: gap });
  });
  return parts;
}

/** The time a strip takes on the scale: everything except the time away. */
const onScaleMs = (parts: StripPart[]) => parts.filter((part) => part.type !== 'away').reduce((total, part) => total + part.ms, 0);

/** The one scale the strip is drawn to: its own length, up to the cap. */
export function scaleFor(allParts: StripPart[][]): number {
  const longest = allParts.reduce((most, parts) => Math.max(most, onScaleMs(parts)), 0);
  return Math.max(SCALE_FLOOR_MS, Math.min(SCALE_CAP_MS, longest));
}

/** A strip cut to a scale: every part placed, how many breaks it has, and, where it was cut, how much was shown of how much there was. */
export interface Fitted {
  parts: PlacedPart[];
  shownMs: number;
  breaks: number;
  clipped: null | { shownMs: number; totalMs: number };
}

/**
 * A strip cut to a scale. `clipped` is null where it fits, and otherwise names how much was shown
 * and how much there was: a cut that said nothing would read as a pull request that ended there.
 *
 * Every part comes back placed: `startMs` is where it begins on the scale (the time before it, not
 * counting time away) and `breaksBefore` how many breaks sit before it, so a part draws at its own
 * time and length whatever sits beside it.
 */
export function fitTo(parts: StripPart[], scaleMs: number): Fitted {
  const totalMs = onScaleMs(parts);
  if (totalMs <= scaleMs) return { ...placed(parts), shownMs: totalMs, clipped: null };

  const shown: (StripPart & { cut?: true })[] = [];
  let used = 0;
  for (const part of parts) {
    const room = scaleMs - used;
    // Before the away branch: a gap after the last part that fits happened beyond
    // the edge, and drawing it would put it inside the span the strip claims to show.
    if (room <= 0) break;
    if (part.type === 'away') {
      shown.push(part);
      continue;
    }
    shown.push(part.ms > room ? { ...part, ms: room, cut: true } : part);
    used += Math.min(part.ms, room);
  }
  return { ...placed(shown), shownMs: used, clipped: { shownMs: used, totalMs } };
}

/** The parts with where each starts on the scale, and how many breaks (time away) sit before it. */
function placed(parts: (StripPart & { cut?: true })[]): { parts: PlacedPart[]; breaks: number } {
  let startMs = 0;
  let breaks = 0;
  const out = parts.map((part) => {
    const placement = { ...part, startMs, breaksBefore: breaks };
    if (part.type === 'away') breaks += 1;
    else startMs += part.ms;
    return placement;
  });
  return { parts: out, breaks };
}

/** Axis steps, whole clock minutes up to a day: the smallest that puts no more than `AXIS_TICKS` across the strip. */
const AXIS_STEPS_MS = [1, 2, 5, 10, 15, 30, 60, 120, 180, 360, 720, 1440].map((minutes) => minutes * 60_000);
const AXIS_TICKS = 8;
/** A tick this close (as a share of the strip) to an end or the edge of a break is left out, since its label would sit on the other's. */
const AXIS_CROWD = 0.07;

export interface Tick {
  atMs: number;
  startMs: number;
  breaksBefore: number;
  align: 'start' | 'end' | 'mid';
}

/**
 * The clock-time axis of a strip drawn on its own scale: a tick at the start, at the end, at each
 * edge of a break (but the last break's far edge where the merge crowds it), and at round Belgian
 * clock times between (src/belgium.ts). Time away has no ticks
 * inside it, so the axis reads the real clock either side of a break. `align` says which side of its
 * tick a label hangs on.
 *
 * @param startedAt the strip's start, in epoch milliseconds
 * @param fitted a strip from `fitTo`
 * @returns in order of position
 */
export function axisFor(startedAt: number, fitted: Fitted): Tick[] {
  const ticks: (Tick & { edge?: true })[] = [];
  const edge = (atMs: number, offsetMs: number, breaksBefore: number, align: Tick['align']) => ticks.push({ atMs, startMs: offsetMs, breaksBefore, align, edge: true });
  let clock = startedAt;
  edge(clock, 0, 0, 'start');
  for (const part of fitted.parts) {
    if (part.type === 'away') {
      edge(clock, part.startMs, part.breaksBefore, 'end');
      edge(clock + part.ms, part.startMs, part.breaksBefore + 1, 'start');
    }
    clock += part.ms;
  }
  const breaks = fitted.parts.filter((part) => part.type === 'away').length;
  // The clock picking up after the last time away gives way to the merge where the two would crowd, since its label would hang past the axis's end.
  const last = ticks[ticks.length - 1]!;
  if (ticks.length > 1 && last.breaksBefore === breaks && fitted.shownMs - last.startMs < fitted.shownMs * AXIS_CROWD) ticks.pop();
  edge(clock, fitted.shownMs, breaks, 'end');

  const step = AXIS_STEPS_MS.find((each) => fitted.shownMs / each <= AXIS_TICKS) ?? AXIS_STEPS_MS[AXIS_STEPS_MS.length - 1]!;
  const crowded = (offsetMs: number, breaksBefore: number) =>
    ticks.some((tick) => tick.edge && tick.breaksBefore === breaksBefore && Math.abs(tick.startMs - offsetMs) < fitted.shownMs * AXIS_CROWD);
  clock = startedAt;
  for (const part of fitted.parts) {
    if (part.type !== 'away') {
      for (let at = nextRoundTime(clock, step); at < clock + part.ms; at = nextRoundTime(at + 1, step)) {
        const offsetMs = part.startMs + (at - clock);
        if (!crowded(offsetMs, part.breaksBefore)) ticks.push({ atMs: at, startMs: offsetMs, breaksBefore: part.breaksBefore, align: 'mid' });
      }
    }
    clock += part.ms;
  }
  return ticks.map(({ edge: _edge, ...tick }) => tick).sort((a, b) => a.breaksBefore - b.breaksBefore || a.startMs - b.startMs || a.atMs - b.atMs);
}
