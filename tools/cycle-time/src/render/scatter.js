/**
 * The layout of the coding-against-harness scatter: where each dot goes, which sit
 * beyond the scale, and which three are labelled. No markup here — html.js draws
 * what this returns — and no clock.
 *
 * Both axes share one scale, so the line where the harness took exactly as long as
 * the coding is a true diagonal and a dot above it is one where the harness took
 * longer. The scale fits the data up to a cap; a dot past it is put on the edge and
 * marked `off`, since a dot drawn where it is not would be a wrong number.
 */

const MIN = 60_000;

/** The longest either axis is drawn to before a dot is pushed onto the edge. */
const SCALE_CAP_MS = 120 * MIN;

/** Below this the scale would be a scale of nothing. */
const SCALE_FLOOR_MS = 30 * MIN;

/** Gridline steps, smallest first: the first that keeps the axis to six intervals. */
const STEPS_MS = [5, 10, 15, 30, 60].map((minutes) => minutes * MIN);

/** How many of the dots furthest above the equal line are named on the chart. */
const LABELLED = 3;

/** The side of the square plot, in the pixels the page draws it at. Labels are placed in these, so the page and the layout share one. */
export const PLOT_SIZE = 380;

/** A dot's radius in pixels runs from 4 to 14 by the square root of its lines over the window's largest, so its area tracks the lines. Nothing changed anywhere is the smallest dot. */
export const radiusFor = (lines, maxLines) => (maxLines > 0 ? Math.min(14, 4 + 10 * Math.sqrt(Math.max(0, lines) / maxLines)) : 4);

/** A dot's shade is its CI rounds in five steps: 1, 2, 3, 4 and 5 or more. */
export const shadeFor = (rounds) => Math.min(5, Math.max(1, Math.floor(rounds)));

/** A label's box, estimated from its characters since the layout has no font to measure: 11px semibold, a digit about 6.5px wide, and a pixel of ring either side. */
const LABEL = { charWidth: 7, height: 14, gap: 4, apart: 2 };

/** A dot on the plot's edge has its label centred on it, so half a label's height may stand outside the plot; sideways it may not, or it would sit on the axis numbers. */
const SLACK_Y = LABEL.height / 2;

const SLOTS = ['right', 'left', 'below'];

/** The box (left, top, right, bottom, in plot pixels from the top-left) and text position a label would take in a slot. */
function labelAt(slot, cx, cy, r, width) {
  if (slot === 'right') return { slot, anchor: 'start', x: cx + r + LABEL.gap, y: cy + 4, box: [cx + r + LABEL.gap, cy - LABEL.height / 2, cx + r + LABEL.gap + width, cy + LABEL.height / 2] };
  if (slot === 'left') return { slot, anchor: 'end', x: cx - r - LABEL.gap, y: cy + 4, box: [cx - r - LABEL.gap - width, cy - LABEL.height / 2, cx - r - LABEL.gap, cy + LABEL.height / 2] };
  const top = cy + r + LABEL.gap;
  return { slot, anchor: 'middle', x: cx, y: top + LABEL.height - 4, box: [cx - width / 2, top, cx + width / 2, top + LABEL.height] };
}

const inside = ([left, top, right, bottom]) => left >= 0 && right <= PLOT_SIZE && top >= -SLACK_Y && bottom <= PLOT_SIZE + SLACK_Y;
const overlap = (a, b) => a[0] < b[2] + LABEL.apart && b[0] < a[2] + LABEL.apart && a[1] < b[3] + LABEL.apart && b[1] < a[3] + LABEL.apart;

/**
 * Each named dot's label is placed in the first slot (right of its dot, then left, then below) that
 * stands inside the plot and overlaps no label already placed, furthest above the line first; one
 * with no free slot gets none, since a label over another would be unreadable.
 *
 * @param {{ number: number, codingMs: number, harnessMs: number, rounds: number, lines: number, ratio: number|null }[]} dots
 * @param {number|null} medianRatio the window's median of `harnessMs / codingMs`
 * @returns {{ scaleMs: number, stepMs: number, ticks: number[], maxLines: number, sizeKey: { lines: number, radius: number }[], dots: object[], median: null | { x: number, y: number } }}
 *   positions are fractions of the plot, 0 to 1 from the origin; `median` is where its line leaves the plot;
 *   a dot's `label` is null or where its text goes, in plot pixels from the top-left
 */
export function layoutScatter(dots, medianRatio) {
  const longest = Math.min(SCALE_CAP_MS, dots.reduce((most, dot) => Math.max(most, dot.codingMs, dot.harnessMs), 0));
  const stepMs = STEPS_MS.find((step) => Math.ceil(longest / step) <= 6) ?? STEPS_MS[STEPS_MS.length - 1];
  const scaleMs = Math.min(SCALE_CAP_MS, Math.max(SCALE_FLOOR_MS, Math.ceil(longest / stepMs) * stepMs));
  const ticks = Array.from({ length: Math.floor(scaleMs / stepMs) + 1 }, (_, index) => index * stepMs);

  const aboveTheLine = dots
    .filter((dot) => dot.harnessMs > dot.codingMs)
    .sort((a, b) => b.harnessMs - b.codingMs - (a.harnessMs - a.codingMs) || a.number - b.number)
    .slice(0, LABELLED)
    .map((dot) => dot.number);

  const maxLines = dots.reduce((most, dot) => Math.max(most, dot.lines || 0), 0);
  const placed = dots.map((dot) => {
    const lines = dot.lines || 0;
    return {
      ...dot,
      lines,
      x: Math.min(1, dot.codingMs / scaleMs),
      y: Math.min(1, dot.harnessMs / scaleMs),
      off: dot.codingMs > scaleMs || dot.harnessMs > scaleMs,
      labelled: aboveTheLine.includes(dot.number),
      radius: radiusFor(lines, maxLines),
      step: shadeFor(dot.rounds),
      label: null,
    };
  });

  const taken = [];
  for (const number of aboveTheLine) {
    const dot = placed.find((each) => each.number === number);
    const width = `#${dot.number}`.length * LABEL.charWidth;
    const cx = dot.x * PLOT_SIZE;
    const cy = (1 - dot.y) * PLOT_SIZE;
    const slot = SLOTS.map((name) => labelAt(name, cx, cy, dot.radius, width)).find((each) => inside(each.box) && !taken.some((box) => overlap(each.box, box)));
    if (slot) {
      taken.push(slot.box);
      dot.label = slot;
    }
  }

  // Sample dots for the legend on the window's own scale: the largest and a quarter of it, which is half way up the radius.
  const sizeKey = [...new Set([Math.round(maxLines / 4), maxLines])].map((lines) => ({ lines, radius: radiusFor(lines, maxLines) }));

  return {
    scaleMs,
    stepMs,
    ticks,
    maxLines,
    sizeKey,
    dots: placed,
    // A line through the origin with the median ratio for its slope; it leaves the
    // plot at the right edge if it is shallower than the diagonal, and at the top if not.
    median: medianRatio === null ? null : medianRatio <= 1 ? { x: 1, y: medianRatio } : { x: 1 / medianRatio, y: 1 },
  };
}
