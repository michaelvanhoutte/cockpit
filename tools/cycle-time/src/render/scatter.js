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

/** A dot's radius in pixels: 4 is the smallest a mark may be, and a long-running one is capped so it cannot cover its neighbours. */
export const radiusFor = (rounds) => Math.min(14, 3.5 + 1.5 * rounds);

/**
 * @param {{ number: number, codingMs: number, harnessMs: number, rounds: number, ratio: number|null }[]} dots
 * @param {number|null} medianRatio the window's median of `harnessMs / codingMs`
 * @returns {{ scaleMs: number, stepMs: number, ticks: number[], dots: object[], median: null | { x: number, y: number } }}
 *   positions are fractions of the plot, 0 to 1 from the origin; `median` is where its line leaves the plot
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

  return {
    scaleMs,
    stepMs,
    ticks,
    dots: dots.map((dot) => ({
      ...dot,
      x: Math.min(1, dot.codingMs / scaleMs),
      y: Math.min(1, dot.harnessMs / scaleMs),
      off: dot.codingMs > scaleMs || dot.harnessMs > scaleMs,
      labelled: aboveTheLine.includes(dot.number),
    })),
    // A line through the origin with the median ratio for its slope; it leaves the
    // plot at the right edge if it is shallower than the diagonal, and at the top if not.
    median: medianRatio === null ? null : medianRatio <= 1 ? { x: 1, y: medianRatio } : { x: 1 / medianRatio, y: 1 },
  };
}
