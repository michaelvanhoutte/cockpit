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
 */

import { AWAY_MS, LOCAL_REVIEW_KINDS, LOCAL_RUN_KINDS } from '../model.js';

/** Top to bottom in a stack of parallel lanes: each review, then the test run, then the browser pass. */
const LANE_ORDER = [...LOCAL_REVIEW_KINDS, ...LOCAL_RUN_KINDS];

/** The longest stretch of time a strip is drawn to before it is cut. */
const SCALE_CAP_MS = 4 * 3_600_000;

/** Below this a scale would be a scale of nothing, and every part would draw as full width. */
const SCALE_FLOOR_MS = 60_000;

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
      parts.push({ type: 'parallel', ms: stretch.to - stretch.from, lanes });
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
    parts.push({ type: 'round', ms: round.ms, round, index: position + 1 });
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
 * @returns {{ parts: object[], shownMs: number, clipped: null | { shownMs: number, totalMs: number } }}
 */
export function fitTo(parts, scaleMs) {
  const totalMs = onScaleMs(parts);
  if (totalMs <= scaleMs) return { parts, shownMs: totalMs, clipped: null };

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
  return { parts: shown, shownMs: used, clipped: { shownMs: used, totalMs } };
}
