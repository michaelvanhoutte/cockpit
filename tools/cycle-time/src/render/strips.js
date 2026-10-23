/**
 * The layout of a pull request's strip: which parts it spent, in order, and how
 * much of a shared time scale each takes. No markup here — html.js draws what this
 * returns — and no clock, so a test can hand it any pull request the model builds.
 *
 *   coding ─ round ─ fixing ─ round ─ wait ─ (merge)
 *
 * Every strip is drawn against one scale, so a long one is longer than a short
 * one rather than each filling its row. Time away (a gap of over three hours, see
 * `AWAY_MS`) is not on that scale: it would swallow the row, and is drawn as a
 * fixed break instead. A strip that still outruns the scale is cut at its edge
 * and says how much it cut.
 *
 * Every part sits at its own time and length on that scale (`fitTo` places them): none
 * is padded, and none pushes another along. A slice too short to see is drawn a little
 * wider by the page, over what follows it, and what follows still starts at its own time.
 */

import { nextRoundTime } from '../../../../scripts/lib/belgian-time.mjs';
import { AWAY_MS, LOCAL_REVIEW_KINDS, LOCAL_RUN_KINDS } from '../model.js';

/** Top to bottom in a stack of parallel lanes: each review, then the test run, then the browser pass. */
const LANE_ORDER = [...LOCAL_REVIEW_KINDS, ...LOCAL_RUN_KINDS];

/** The longest stretch of time a strip is drawn to before it is cut. */
const SCALE_CAP_MS = 4 * 3_600_000;

/** Below this a scale would be a scale of nothing, and every part would draw as full width. */
const SCALE_FLOOR_MS = 60_000;

/** The row a lane takes in a stack, by its rank in length: 0 is the strip's line, then above (-1), below (1), further above (-2), further below (2)... */
const rowOfRank = (rank) => (rank === 0 ? 0 : rank % 2 === 1 ? -(rank + 1) / 2 : rank / 2);

/**
 * One gap of writing — before the first push, or between rounds — as the stretches of
 * `type` and the local work that sat in it, in the order it ran. The slices are the
 * model's, already cut to the gap, so what is left of `type` is the gap's length less
 * them, and the strip adds up to the same minutes the scatter's harness does. Slices
 * that overlap are one `parallel` part holding a lane per slice.
 */
function gapParts(type, from, to, slices) {
  const ranges = slices
    .map((slice) => ({ slice, from: Math.max(from, Date.parse(slice.at)), to: Math.min(to, Date.parse(slice.at) + slice.ms) }))
    .filter((range) => range.to > range.from)
    .sort((a, b) => a.from - b.from || a.to - b.to);
  // Slices that overlap, directly or through a chain of them, are one stretch of parallel work.
  const stretches = [];
  for (const range of ranges) {
    const last = stretches[stretches.length - 1];
    if (last && range.from < last.to) {
      last.ranges.push(range);
      last.to = Math.max(last.to, range.to);
    } else stretches.push({ from: range.from, to: range.to, ranges: [range] });
  }

  const parts = [];
  let cursor = from;
  for (const stretch of stretches) {
    if (stretch.from > cursor) parts.push({ type, ms: stretch.from - cursor });
    if (stretch.ranges.length === 1) parts.push({ ...describe(stretch.ranges[0].slice), ms: stretch.to - stretch.from });
    else {
      // One lane per thread, in the fixed order; each sits where its own work does, so a lane that ends early leaves the rest of the stretch to the others.
      const lanes = stretch.ranges
        .map((range) => ({ ...describe(range.slice), offsetMs: range.from - stretch.from, ms: range.to - range.from }))
        .sort((a, b) => LANE_ORDER.indexOf(a.kind) - LANE_ORDER.indexOf(b.kind) || a.offsetMs - b.offsetMs);
      // The longest piece stays on the strip's line, so the line is never blank; the others stack off it. Equal lengths fall back on the fixed order, so the same piece holds the line on every render.
      [...lanes]
        .sort((a, b) => b.ms - a.ms || LANE_ORDER.indexOf(a.kind) - LANE_ORDER.indexOf(b.kind) || a.offsetMs - b.offsetMs)
        .forEach((lane, rank) => {
          lane.row = rowOfRank(rank);
        });
      // `base` is what the line shows where no lane of it is running: the coding or fixing the stretch sat in.
      parts.push({ type: 'parallel', base: type, ms: stretch.to - stretch.from, lanes });
    }
    cursor = stretch.to;
  }
  if (to > cursor) parts.push({ type, ms: to - cursor });
  return parts;
}

/** What a strip says of one local slice: its kind, level or scope, and the length of the whole slice, which a part cut by another slice is shorter than. */
function describe(slice) {
  return {
    type: LOCAL_REVIEW_KINDS.includes(slice.kind) ? 'review' : slice.kind,
    kind: slice.kind,
    ...(slice.level ? { level: slice.level } : {}),
    ...(slice.scopes ? { scopes: slice.scopes } : {}),
    ...(slice.endedTogether ? { endedTogether: true } : {}),
    at: slice.at,
    sliceMs: slice.ms,
  };
}

/**
 * A round's jobs placed in rows: a job takes the free row that ended last, from its lead's start to
 * its end, so jobs that overlapped sit in different rows and one that waited on another sits in
 * its row after it. The row that was busiest holds the strip's line, then the next above it, then
 * below, as for local work in parallel, so the same jobs hold the same rows on every render.
 * `null` where the round's jobs are not recorded.
 *
 * @param {object[]|null|undefined} lanes the model's `round.lanes`
 */
export function placeLanes(lanes) {
  if (!Array.isArray(lanes)) return null;
  const rows = [];
  const placed = lanes.map((lane) => {
    const occupiedFrom = lane.offsetMs - lane.leadMs;
    // The free row that ended last, so a job that began where another ended carries on its row.
    let index = -1;
    rows.forEach((row, each) => {
      if (row.end <= occupiedFrom && (index === -1 || row.end > rows[index].end)) index = each;
    });
    if (index === -1) index = rows.push({ end: -Infinity, busy: 0 }) - 1;
    rows[index].end = lane.offsetMs + lane.ms;
    rows[index].busy += lane.leadMs + lane.ms;
    return { ...lane, packed: index };
  });
  const ranked = rows.map((row, index) => ({ index, busy: row.busy })).sort((a, b) => b.busy - a.busy || a.index - b.index);
  const rowOf = new Map(ranked.map((row, rank) => [row.index, rowOfRank(rank)]));
  return placed.map(({ packed, ...lane }) => ({ ...lane, row: rowOf.get(packed) }));
}

/**
 * A pull request's parts, in the order they were spent. Empty where no check ever
 * ran on it, since every part after the first push is measured from a round.
 *
 * @param {object} pull a pull request from the model
 * @returns {{ type: 'coding'|'review'|'test'|'browser'|'parallel'|'round'|'fixing'|'wait'|'away', ms: number, round?: object, index?: number, kind?: string, level?: string, scopes?: string[], lanes?: object[] }[]}
 */
export function partsOf(pull) {
  const parts = [];
  if (pull.rounds.length === 0) return parts;
  const slicesIn = (gap) => [...(pull.reviewSlices ?? []), ...(pull.runSlices ?? [])].filter((slice) => slice.gap === gap);

  const firstPush = Date.parse(pull.rounds[0].pushedAt);
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
const onScaleMs = (parts) => parts.filter((part) => part.type !== 'away').reduce((total, part) => total + part.ms, 0);

/** The one scale every strip on the page is drawn to: the longest of them, up to the cap. */
export function scaleFor(allParts) {
  const longest = allParts.reduce((most, parts) => Math.max(most, onScaleMs(parts)), 0);
  return Math.max(SCALE_FLOOR_MS, Math.min(SCALE_CAP_MS, longest));
}

/**
 * A strip cut to a scale. `clipped` is null where it fits, and otherwise names how
 * much was shown and how much there was — a cut that said nothing would read as a
 * pull request that ended there.
 *
 * Every part comes back placed: `startMs` is where it begins on the scale (the time
 * before it, not counting time away) and `breaksBefore` how many breaks sit before
 * it, so a part draws at its own time and length whatever sits beside it.
 *
 * @returns {{ parts: object[], shownMs: number, breaks: number, clipped: null | { shownMs: number, totalMs: number } }}
 */
export function fitTo(parts, scaleMs) {
  const totalMs = onScaleMs(parts);
  if (totalMs <= scaleMs) return { ...placed(parts), shownMs: totalMs, clipped: null };

  const shown = [];
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
function placed(parts) {
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

/**
 * The clock-time axis of a strip drawn on its own scale: a tick at the start, at the end, at each edge of a
 * break, and at round Belgian clock times between (scripts/lib/belgian-time.mjs). Time away has no ticks inside it, so the axis reads the real
 * clock either side of a break. `align` says which side of its tick a label hangs on.
 *
 * @param {number} startedAt the strip's start, in epoch milliseconds
 * @param {{ parts: object[], shownMs: number }} fitted a strip from `fitTo`
 * @returns {{ atMs: number, startMs: number, breaksBefore: number, align: 'start'|'end'|'mid' }[]} in order of position
 */
export function axisFor(startedAt, fitted) {
  const ticks = [];
  const edge = (atMs, offsetMs, breaksBefore, align) => ticks.push({ atMs, startMs: offsetMs, breaksBefore, align, edge: true });
  let clock = startedAt;
  edge(clock, 0, 0, 'start');
  for (const part of fitted.parts) {
    if (part.type === 'away') {
      edge(clock, part.startMs, part.breaksBefore, 'end');
      edge(clock + part.ms, part.startMs, part.breaksBefore + 1, 'start');
    }
    clock += part.ms;
  }
  edge(clock, fitted.shownMs, fitted.parts.filter((part) => part.type === 'away').length, 'end');

  const step = AXIS_STEPS_MS.find((each) => fitted.shownMs / each <= AXIS_TICKS) ?? AXIS_STEPS_MS[AXIS_STEPS_MS.length - 1];
  const crowded = (offsetMs, breaksBefore) => ticks.some((tick) => tick.edge && tick.breaksBefore === breaksBefore && Math.abs(tick.startMs - offsetMs) < fitted.shownMs * AXIS_CROWD);
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
