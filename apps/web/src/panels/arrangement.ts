import { DEFAULT_PANEL_SIZE, GRID_COLUMNS, MAX_PANEL_ROWS } from '@cockpit/shared';
import type { Layout, Panel, PanelPlacement } from '@cockpit/shared';

/**
 * How a dashboard is arranged, decided here and nowhere else ("Panels on a
 * dashboard, with per-screen-size layouts", issue 33).
 *
 * Pure on purpose. Every rule in the issue about *which* layout is used and
 * *where* the panels end up is a decision over a list and a number, so it is
 * provable without a browser - and what genuinely needs one, that the page
 * never scrolls sideways, is a claim about layout that no amount of arithmetic
 * here can make.
 */

/**
 * How wide a panel wants to be before it stops being worth splitting a row
 * further. Not a breakpoint: it is only ever divided into the width the panels
 * have, to answer "how many fit across", so a screen of any width gets an
 * answer rather than falling into a bucket.
 *
 * 420px is about the width of a phone laid out at its comfortable size, and it
 * is what makes a 480px phone one panel across, a 1280px laptop three, and
 * anything wider four.
 *
 * What it is divided into is the width the *panels* have, not the window's:
 * where the Inbox sits beside them it takes about a fifth of the screen
 * ("Show the Inbox beside the dashboards instead of as a tab", issue 117), and
 * three across a 1280px screen would be three across nine hundred and ninety
 * pixels.
 */
export const COMFORTABLE_PANEL_WIDTH = 420;

/**
 * The most panels put side by side, however wide the screen. Four already means
 * a 2560px screen giving each one 640px; past that the panels stop being boxes
 * you read and become a strip of columns, and the person can always make them
 * narrower by hand.
 *
 * It is also what keeps the arithmetic honest: the grid has twelve columns, and
 * one, two, three and four are the counts that divide it into whole ones.
 */
const MOST_ACROSS = 4;

/**
 * How many panels fit across a space this wide, at a size worth reading.
 *
 * Rounded rather than floored, which is not a detail: flooring asks how many
 * *whole* comfortable panels fit, so 790px - the width a dashboard has beside
 * the Inbox on a small laptop - would be one panel of 790 rather than two of
 * 395. Rounding picks the count whose panels land closest to comfortable, which
 * is the question actually being asked.
 */
export function panelsAcross(availableWidth: number): number {
  const wanted = Math.round(availableWidth / COMFORTABLE_PANEL_WIDTH);
  return Math.min(MOST_ACROSS, Math.max(1, wanted));
}

/**
 * How near a screen has to be to a layout's own width to count as the screen it
 * was made for.
 *
 * Exact equality would be unusable: a scrollbar appearing takes about fifteen
 * pixels off the width, and a window nudged by a few would count as a different
 * screen and start asking which layout to change on every drag. Forty is under
 * a tenth of the narrowest screen the app is drawn on, so nothing that is
 * really a different size can hide inside it.
 */
export const SAME_SCREEN_TOLERANCE = 40;

/** Whether this layout is the one this screen is actually the width of. */
export function madeForThisScreen(layout: Layout, screenWidth: number): boolean {
  return Math.abs(layout.screenWidth - screenWidth) <= SAME_SCREEN_TOLERANCE;
}

/**
 * The layout a dashboard is drawn with: the one chosen by hand while it is
 * still there, and otherwise the one whose recorded width is closest to this
 * screen.
 *
 * A chosen layout that has been deleted falls straight through to the closest
 * remaining one, which is the issue's rule for a deleted layout arriving by the
 * only route it can - nothing has to notice the deletion and clear the choice.
 *
 * Ties go to the narrower layout. Any tie-break would do; having one is what
 * stops the same dashboard being drawn two ways on two devices of the same
 * width.
 */
export function layoutToDraw(
  layouts: readonly Layout[],
  dashboardId: string,
  screenWidth: number,
  chosenLayoutId: string | null,
): Layout | null {
  const its = layouts.filter((layout) => layout.dashboardId === dashboardId);
  const chosen = its.find((layout) => layout.id === chosenLayoutId);
  if (chosen) return chosen;
  return its.reduce<Layout | null>((closest, layout) => {
    if (!closest) return layout;
    const near = Math.abs(layout.screenWidth - screenWidth);
    const nearest = Math.abs(closest.screenWidth - screenWidth);
    if (near < nearest) return layout;
    if (near === nearest && layout.screenWidth < closest.screenWidth) return layout;
    return closest;
  }, null);
}

/** A span that the grid can actually draw, whatever was stored. */
function withinTheGrid(placement: PanelPlacement): PanelPlacement {
  return {
    panelId: placement.panelId,
    columns: clamp(Math.round(placement.columns), 1, GRID_COLUMNS),
    rows: clamp(Math.round(placement.rows), 1, MAX_PANEL_ROWS),
  };
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, Number.isFinite(value) ? value : low));
}

/**
 * An arrangement made for the width the panels have: them in the order given,
 * filling rows left to right, each one an equal share of it.
 *
 * This is what "Fit to this screen" does and what a dashboard with no layout at
 * all is drawn with, which is deliberately the same function: the arrangement
 * you get before you have arranged anything should be the arrangement the
 * button would give you, rather than the button moving everything the first
 * time it is pressed.
 *
 * That does mean pressing it on a never-arranged dashboard changes nothing on
 * screen. It is not a no-op, though, and the board is careful about the
 * difference: what the press records is a *layout* for this screen, which is
 * the thing that was not there before.
 *
 * Heights are left alone. Rearranging is about how many fit across; a panel
 * somebody made tall stays tall, and a phone layout does not silently flatten
 * the one thing on it that was meant to be big.
 */
export function fittedToScreen(
  placements: readonly PanelPlacement[],
  availableWidth: number,
): PanelPlacement[] {
  const columns = GRID_COLUMNS / panelsAcross(availableWidth);
  return placements.map((placement) => ({ ...withinTheGrid(placement), columns }));
}

/**
 * The arrangement actually drawn: the layout's own, minus panels that are no
 * longer there, plus panels it has never heard of.
 *
 * Both halves are real. A panel deleted in another tab is gone from the
 * snapshot while this layout still names it, and a panel added in another tab
 * is in the snapshot while this layout does not - and a dashboard that dropped
 * a panel because one arrangement was stale would be hiding something a person
 * made. Appended at the end, at the size of whatever is last, for the reason
 * the server appends one: a phone layout's panels are full width, and a
 * newcomer given a third of the grid would be visibly wrong on the one screen
 * it was supposed to fit.
 */
export function drawnArrangement(
  layout: Layout | null,
  panels: readonly Panel[],
  availableWidth: number,
): PanelPlacement[] {
  if (!layout) {
    return fittedToScreen(
      panels.map((panel) => ({ panelId: panel.id, ...DEFAULT_PANEL_SIZE })),
      availableWidth,
    );
  }
  const live = new Set(panels.map((panel) => panel.id));
  const placed = layout.placements.filter((p) => live.has(p.panelId)).map(withinTheGrid);
  const seen = new Set(placed.map((p) => p.panelId));
  const drawn = [...placed];
  for (const panel of panels) {
    if (seen.has(panel.id)) continue;
    const last = drawn.at(-1);
    drawn.push({
      panelId: panel.id,
      columns: last?.columns ?? DEFAULT_PANEL_SIZE.columns,
      rows: last?.rows ?? DEFAULT_PANEL_SIZE.rows,
    });
  }
  return drawn;
}

/**
 * The arrangement with one panel moved one place towards the front or the back.
 *
 * A move rather than a coordinate, because that is what the issue asks for:
 * panels flow left to right and wrap, so putting one before another is the only
 * kind of move there is - and it is the same operation whether it came from a
 * drag or from the entry in the panel's own menu, which is what a keyboard and
 * a phone reach for.
 *
 * A panel already at the end it is being moved towards stays where it is, and
 * the list comes back unchanged: nothing has to ask first.
 */
export function movedBy(
  placements: readonly PanelPlacement[],
  panelId: string,
  places: number,
): PanelPlacement[] {
  const from = placements.findIndex((placement) => placement.panelId === panelId);
  if (from < 0) return [...placements];
  const to = from + places;
  if (to < 0 || to >= placements.length) return [...placements];
  const moved = [...placements];
  const [taken] = moved.splice(from, 1);
  moved.splice(to, 0, taken!);
  return moved;
}

/**
 * The arrangement with one panel picked up and dropped in front of another -
 * what a drag ends with.
 *
 * Dropping a panel on itself, or on one that is not in the arrangement, leaves
 * everything where it was.
 */
export function movedBefore(
  placements: readonly PanelPlacement[],
  panelId: string,
  beforePanelId: string,
): PanelPlacement[] {
  if (panelId === beforePanelId) return [...placements];
  const from = placements.findIndex((placement) => placement.panelId === panelId);
  const onto = placements.findIndex((placement) => placement.panelId === beforePanelId);
  if (from < 0 || onto < 0) return [...placements];
  const moved = [...placements];
  const [taken] = moved.splice(from, 1);
  // Taking the panel out first shifts everything after it down one, so the
  // target's index has to be read again rather than reused - dragging left to
  // right would otherwise land one place short every time.
  const landing = moved.findIndex((placement) => placement.panelId === beforePanelId);
  moved.splice(landing, 0, taken!);
  return moved;
}

/**
 * The arrangement with one panel resized, in whole grid steps, never past the
 * edges of the grid.
 *
 * Clamped rather than refused: a resize is a drag, and a drag that runs past
 * the edge means "as far as it goes" rather than "do nothing".
 */
export function resizedTo(
  placements: readonly PanelPlacement[],
  panelId: string,
  size: { columns?: number; rows?: number },
): PanelPlacement[] {
  return placements.map((placement) =>
    placement.panelId === panelId
      ? withinTheGrid({
          panelId,
          columns: size.columns ?? placement.columns,
          rows: size.rows ?? placement.rows,
        })
      : placement,
  );
}

/** Whether two arrangements say the same thing, so nothing is sent when nothing moved. */
export function sameArrangement(
  one: readonly PanelPlacement[],
  other: readonly PanelPlacement[],
): boolean {
  return (
    one.length === other.length &&
    one.every((placement, at) => {
      const against = other[at]!;
      return (
        placement.panelId === against.panelId &&
        placement.columns === against.columns &&
        placement.rows === against.rows
      );
    })
  );
}
