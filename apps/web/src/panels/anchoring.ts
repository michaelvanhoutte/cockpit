/**
 * Keeping a header where the pointer is while the board collapses or opens.
 *
 * Pure, because what it is given is measurements and what it returns is
 * numbers: that the page really lays out this way is the browser walk's
 * (tests/e2e/panels.test.ts).
 */

export interface Anchoring {
  /** Where the header is wanted: its top before the board changed shape. */
  wanted: number;
  /** Where the header is now, the board having changed shape. */
  now: number;
  scrollTop: number;
  /** How far the Dashboard can scroll in its new shape. */
  maxScrollTop: number;
}

/**
 * What puts the header back: the scroll position to set, and how much the
 * board is moved by besides - positive is empty room above it, negative is
 * the board pulled up.
 *
 * **The Dashboard scrolls by the difference first**, and only what it cannot
 * scroll is made up by moving the board: a collapsed board too short to
 * scroll that far gains room above it, and one whose gap above the first row
 * opened and cannot scroll back down is pulled up by the shortfall.
 */
export function anchored({ wanted, now, scrollTop, maxScrollTop }: Anchoring): {
  scrollTop: number;
  shift: number;
} {
  const target = Math.min(Math.max(scrollTop + (now - wanted), 0), Math.max(maxScrollTop, 0));
  const headerAfter = now - (target - scrollTop);
  return { scrollTop: target, shift: wanted - headerAfter };
}
