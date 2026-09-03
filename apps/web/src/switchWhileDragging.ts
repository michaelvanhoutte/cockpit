/**
 * Switching dashboards by resting a drag on one ("Scroll while dragging, and
 * switch dashboards by resting on one", issue 143).
 *
 * **The scrolling half of that issue needed no code.** Chromium scrolls the
 * container under the pointer during its own drag-and-drop, and so does every
 * browser this app targets - measured, by taking a hand-written frame loop out
 * and watching the browser walk pass unchanged. What was written first is gone;
 * what is left is the walk that proves a panel below the fold can be reached.
 *
 * **The deciding is here, and pure, for the reason the swipe's is** (swipe.ts):
 * jsdom performs no drag and runs no animation frames, so a test driving drag
 * events against it would be measuring nothing. What is provable without a
 * browser is when a rest has lasted long enough.
 */

/**
 * How long a drag has to rest on a dashboard's name before it switches to it.
 *
 * Long enough not to fire while crossing the bar on the way somewhere else,
 * short enough not to feel stuck. A dwell rather than an immediate switch
 * because the bar sits between the Inbox and the panels: a drag from one to the
 * other passes over every dashboard's name on the way.
 */
export const DWELL_MS = 600;

/**
 * The dashboard to switch to, or null for staying put.
 *
 * Stateless: what is being rested on and since when is the caller's, and
 * leaving a tab clears it - which is what makes "rested, left, and rested
 * again" start the dwell over rather than counting the two together.
 */
export function dashboardToSwitchTo(
  resting: { dashboardId: string; since: number } | null,
  now: number,
  openDashboardId: string | null,
): string | null {
  if (!resting) return null;
  // Already looking at it: a switch to where you are is not a switch, and it
  // would put the drag back at the start of a page that had not moved.
  if (resting.dashboardId === openDashboardId) return null;
  if (now - resting.since < DWELL_MS) return null;
  return resting.dashboardId;
}
