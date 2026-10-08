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
  /** The board is open, a Panel having been dropped: scrolling alone places the header. */
  opening?: boolean;
}

/**
 * What puts the header back: the scroll position to set, and how much the board
 * is moved by besides - positive is empty room above it, negative is the board
 * pulled up.
 *
 * **The Dashboard scrolls by the difference first**, and only what it cannot
 * scroll is made up by moving the board while a Panel is in the air: a
 * collapsed board too short to scroll that far gains room above it, and one
 * whose gap above the first row opened and cannot scroll back down is pulled up
 * by the shortfall.
 *
 * **An open board is only ever scrolled.** Measured with the room above it
 * already taken back, what the Dashboard cannot reach is given up: no room
 * above, no room below, no pull-up. The scroll stays within the Dashboard.
 */
export function anchored({ wanted, now, scrollTop, maxScrollTop, opening = false }: Anchoring): {
  scrollTop: number;
  shift: number;
} {
  const target = Math.min(Math.max(scrollTop + (now - wanted), 0), Math.max(maxScrollTop, 0));
  if (opening) return { scrollTop: target, shift: 0 };
  const headerAfter = now - (target - scrollTop);
  return { scrollTop: target, shift: wanted - headerAfter };
}
