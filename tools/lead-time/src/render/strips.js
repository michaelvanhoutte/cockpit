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

import { AWAY_MS } from '../model.js';

/** The longest stretch of time a strip is drawn to before it is cut. */
const SCALE_CAP_MS = 4 * 3_600_000;

/** Below this a scale would be a scale of nothing, and every part would draw as full width. */
const SCALE_FLOOR_MS = 60_000;

/**
 * A pull request's parts, in the order they were spent. Empty where no check ever
 * ran on it, since every part after the first push is measured from a round.
 *
 * @param {object} pull a pull request from the model
 * @returns {{ type: 'coding'|'round'|'fixing'|'wait'|'away', ms: number, round?: object, index?: number }[]}
 */
export function partsOf(pull) {
  const parts = [];
  if (pull.rounds.length === 0) return parts;

  if (pull.beforeFirstPushMs > 0) parts.push({ type: 'coding', ms: pull.beforeFirstPushMs });
  pull.rounds.forEach((round, position) => {
    parts.push({ type: 'round', ms: round.ms, round, index: position + 1 });
    const next = pull.rounds[position + 1];
    const gap = Math.max(0, Date.parse(next ? next.pushedAt : pull.mergedAt) - Date.parse(round.endedAt));
    if (gap > AWAY_MS) parts.push({ type: 'away', ms: gap });
    else if (gap > 0) parts.push({ type: next ? 'fixing' : 'wait', ms: gap });
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
