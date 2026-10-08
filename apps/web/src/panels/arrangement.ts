import {
  DEFAULT_CELL_SPAN,
  GRID_COLUMNS,
  isPhoneWidth,
  MAX_ROW_HEIGHT,
  MIN_ROW_HEIGHT,
  MOST_ACROSS,
  rowIsSection,
} from '@cockpit/shared';
import type { Layout, LayoutCell, LayoutRow, Panel, RowInput } from '@cockpit/shared';

/**
 * How a dashboard is arranged, decided here and nowhere else - a list of rows,
 * each holding the panels across it ("Rows of panels, not a grid that wraps").
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
 * is what makes a phone one panel across (anything under 480px, `isPhoneWidth`,
 * and 480px itself), a 1280px laptop three, and anything wider four.
 *
 * What it is divided into is the width the *panels* have, not the window's:
 * where the Inbox sits beside them it takes about a fifth of the screen
 * ("Show the Inbox beside the dashboards instead of as a tab", issue 117), and
 * three across a 1280px screen would be three across nine hundred and ninety
 * pixels.
 */
export const COMFORTABLE_PANEL_WIDTH = 420;

/**
 * How many panels fit across a space this wide, at a size worth reading.
 *
 * **Only a dashboard nobody has arranged asks this.** Once there are rows, how
 * many panels are on a line is what somebody put there; this answers the one
 * case where nothing has been decided yet, and `MOST_ACROSS` caps it at the
 * same four the gestures refuse to exceed.
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
 * The layout a dashboard is drawn with: its one, from 480px up, whatever
 * screen it is looked at on ("Draw a Dashboard on its one Layout, with nothing
 * to choose it by", issue 712), so the same Dashboard is drawn the same way on
 * every device.
 *
 * **None at all on a phone** (`isPhoneWidth`): a Layout is an arrangement made
 * for a wider screen, and handing one to a phone is what drew panels too narrow
 * to read. The Layout is left alone and is read again the moment the window is
 * wide enough; what a phone takes from it is only the order (`stackedOnPhone`).
 */
export function layoutToDraw(
  layouts: readonly Layout[],
  dashboardId: string,
  screenWidth: number,
): Layout | null {
  if (isPhoneWidth(screenWidth)) return null;
  return layouts.find((layout) => layout.dashboardId === dashboardId) ?? null;
}

/**
 * What a phone draws: every panel on a row of its own, in the order a wider
 * screen reads the Layout - rows top to bottom, each row left to right - so a
 * panel dragged to the top on a laptop is at the top on a phone.
 *
 * **Only the order is taken from the Layout**, never its row heights or the
 * panels it puts side by side: they were made for a wider screen. The panels a
 * Layout does not name come after the placed ones and a deleted one is skipped
 * (`drawnRows`); a Dashboard with no Layout stays in the order its panels were
 * added. **A Section is drawn in its place** among them.
 */
export function stackedOnPhone(layout: Layout | null, panels: readonly Panel[]): LayoutRow[] {
  return stacked(drawnRows(layout, panels, 0));
}

/** An arrangement as a phone draws it: every Panel on a row of its own, in reading order, and each Section in its place. */
export function stacked(rows: readonly LayoutRow[]): LayoutRow[] {
  return rows.flatMap((row): LayoutRow[] =>
    rowIsSection(row)
      ? [row]
      : row.cells.map((cell) => ({
          height: null,
          cells: [{ panelId: cell.panelId, span: DEFAULT_CELL_SPAN }],
        })),
  );
}

/**
 * The rows as a save sends them, named field by field rather than sent as read,
 * so a row that arrived from a snapshot with something extra on it cannot carry
 * that back into a change the schema then refuses.
 */
export function rowsToSave(rows: readonly LayoutRow[]): RowInput[] {
  return rows.map((row) =>
    rowIsSection(row)
      ? { height: null, title: row.title, cells: [] }
      : { height: row.height, cells: row.cells.map((cell) => ({ panelId: cell.panelId, span: cell.span })) },
  );
}

/**
 * The arrangement with a Section added at its foot, where a new Panel lands
 * ("Add, rename and delete a titled Section on a Dashboard", issue 896). A
 * Section is told apart from another only by where it is, so the two below
 * name one by how many Sections come before it.
 */
export function withSectionAdded(rows: readonly LayoutRow[], title: string): LayoutRow[] {
  return [...rows, { height: null, title, cells: [] }];
}

/** The arrangement with the `nth` Section given a new title. */
export function withSectionRenamed(rows: readonly LayoutRow[], nth: number, title: string): LayoutRow[] {
  let seen = -1;
  return rows.map((row) => {
    if (!rowIsSection(row)) return row;
    seen += 1;
    return seen === nth ? { ...row, title } : row;
  });
}

/** The arrangement with the `nth` Section taken out, and every Panel where it was. */
export function withSectionDeleted(rows: readonly LayoutRow[], nth: number): LayoutRow[] {
  let seen = -1;
  return rows.filter((row) => {
    if (!rowIsSection(row)) return true;
    seen += 1;
    return seen !== nth;
  });
}

/**
 * The rows a board draws while a Dashboard filter hides the Panels in
 * `hidden` ("Hide a Section the filter empties, and head Go to panel's Panels
 * with their Sections", issue 898), each with the place it has in `rows`, which
 * is what it is keyed by. Null `hidden` is no filter: every row is drawn, a
 * Section with nothing under it too. Filtered, a row with no Panel left goes,
 * and **a Section is drawn only while a row between it and the next Section
 * still has a Panel drawn**.
 */
export function rowsDrawnWithout(
  rows: readonly LayoutRow[],
  hidden: ReadonlySet<string> | null,
): { place: number; row: LayoutRow }[] {
  if (!hidden) return rows.map((row, place) => ({ place, row }));
  const left = rows.map((row, place) => ({
    place,
    row: rowIsSection(row) ? row : { ...row, cells: row.cells.filter((cell) => !hidden.has(cell.panelId)) },
  }));
  return left.filter(({ row, place }) => {
    if (!rowIsSection(row)) return row.cells.length > 0;
    for (const { row: after } of left.slice(place + 1)) {
      if (rowIsSection(after)) return false;
      if (after.cells.length > 0) return true;
    }
    return false;
  });
}

/**
 * The share of its row each cell takes, as a fraction of one.
 *
 * **Spans are proportions, not widths.** They need not sum to anything: a row
 * of 6 and 6 is half each and so is a row of 1 and 1, because what a span means
 * is only ever "this much of the row, next to those". Requiring them to sum to
 * twelve would be a second rule saying the same thing, and it would have to be
 * repaired every time a panel joined a row or left one - which is exactly the
 * arithmetic the wrapping grid used to need.
 *
 * A row whose spans are all zero or worse divides evenly rather than dividing
 * by nothing: a stored arrangement should be drawn, not throw.
 */
export function sharesOf(row: LayoutRow): number[] {
  const spans = row.cells.map((cell) => (Number.isFinite(cell.span) && cell.span > 0 ? cell.span : 0));
  const total = spans.reduce((sum, span) => sum + span, 0);
  if (total <= 0) return spans.map(() => 1 / Math.max(1, spans.length));
  return spans.map((span) => span / total);
}

/**
 * The arrangement actually drawn: the layout's own rows, minus panels that are
 * no longer there, plus panels it has never heard of.
 *
 * Both halves are real. A panel deleted in another tab is gone from the
 * snapshot while this layout still names it, and a panel added in another tab
 * is in the snapshot while this layout does not - and a dashboard that dropped
 * a panel because one arrangement was stale would be hiding something a person
 * made.
 *
 * **A row emptied that way goes with its last panel**, because a row is the
 * panels across it and a blank line is not what a deleted panel should look
 * like. **A panel the layout has never heard of gets a row of its own**, for
 * the reason the server gives one to a panel added elsewhere
 * (apps/api/src/domain/panels.ts): nothing about a newcomer says which panels it
 * belongs beside.
 *
 * A dashboard with no layout at all is arranged for the screen it is on.
 */
export function drawnRows(
  layout: Layout | null,
  panels: readonly Panel[],
  availableWidth: number,
): LayoutRow[] {
  if (!layout) return fittedToScreen(panels, availableWidth);
  const live = new Set(panels.map((panel) => panel.id));
  // A Section holds no Panels and is kept as it is, with nothing under it too.
  const drawn = layout.rows
    .map((row) =>
      rowIsSection(row)
        ? { height: null, title: row.title, cells: [] }
        : { height: row.height, cells: row.cells.filter((cell) => live.has(cell.panelId)) },
    )
    .filter((row) => row.cells.length > 0 || rowIsSection(row));
  const seen = new Set(drawn.flatMap((row) => row.cells.map((cell) => cell.panelId)));
  for (const panel of panels) {
    if (seen.has(panel.id)) continue;
    drawn.push({ height: null, cells: [{ panelId: panel.id, span: DEFAULT_CELL_SPAN }] });
  }
  return drawn;
}

/**
 * The arrangement a dashboard with no layout is drawn with: the panels in the
 * order they were added, filling rows across the screen, each row's panels an
 * equal share of it.
 *
 * This is the one place the old wrapping rule survives, and it belongs here:
 * before anybody has arranged a dashboard there is nothing to say which panels
 * share a line, so how many fit at a size worth reading is the only answer
 * available. Every row after that is somebody's decision.
 *
 * No heights: a row that has never been dragged is as tall as what is on it.
 */
export function fittedToScreen(
  panels: readonly Panel[],
  availableWidth: number,
): LayoutRow[] {
  const across = panelsAcross(availableWidth);
  const rows: LayoutRow[] = [];
  for (let at = 0; at < panels.length; at += across) {
    rows.push({
      height: null,
      cells: panels
        .slice(at, at + across)
        .map((panel) => ({ panelId: panel.id, span: DEFAULT_CELL_SPAN })),
    });
  }
  return rows;
}

/** Where one panel is in an arrangement, or null when it is not in it at all. */
export function findCell(
  rows: readonly LayoutRow[],
  panelId: string,
): { row: number; at: number } | null {
  for (let row = 0; row < rows.length; row += 1) {
    const at = rows[row]!.cells.findIndex((cell) => cell.panelId === panelId);
    if (at >= 0) return { row, at };
  }
  return null;
}

/** The rows with one panel taken out, and any row it emptied taken out with it; a Section stays. */
function withoutPanel(rows: readonly LayoutRow[], panelId: string): LayoutRow[] {
  return rows
    .map((row) => ({ ...row, cells: row.cells.filter((cell) => cell.panelId !== panelId) }))
    .filter((row) => row.cells.length > 0 || rowIsSection(row));
}

/**
 * A row's cells sharing it equally, which is what a row does when its
 * membership changes.
 *
 * **Evenly rather than keeping what was there**, and that is a decision worth
 * stating: a panel joining a row could take its share from the one it landed
 * next to, leaving the others alone. That reads as arbitrary - why that
 * neighbour - and it means a row's proportions drift with the order things were
 * added to it. An even row is the one arrangement nobody has to explain, and
 * the divider gesture is how a row stops being even on purpose.
 */
function evenly(cells: readonly LayoutCell[]): LayoutCell[] {
  return cells.map((cell) => ({ panelId: cell.panelId, span: DEFAULT_CELL_SPAN }));
}

/**
 * The arrangement with one panel put beside another, in that one's row.
 *
 * The row it left is dropped if that emptied it, and the row it *joins* shares
 * itself out evenly. **Only a row whose membership changed**: moving a panel
 * along the row it is already on is a reorder, and evening that row out would
 * throw away proportions somebody set on purpose from a gesture that changed
 * who is on the line.
 *
 * A row already full refuses, and says so by coming back unchanged: four across
 * is where a panel stops being a box you read (`MOST_ACROSS`), and the gestures
 * are where that rule lives - the store keeps whatever it is given.
 */
export function movedBeside(
  rows: readonly LayoutRow[],
  panelId: string,
  besidePanelId: string,
  side: 'before' | 'after',
): LayoutRow[] {
  if (panelId === besidePanelId) return [...rows];
  const moving = findCell(rows, panelId);
  const target = findCell(rows, besidePanelId);
  if (!moving || !target) return [...rows];
  const span = rows[moving.row]!.cells[moving.at]!.span;
  if (rows[target.row]!.cells.length >= MOST_ACROSS && moving.row !== target.row) return [...rows];

  const without = withoutPanel(rows, panelId);
  // Read again rather than reused: taking the panel out can drop a whole row,
  // which moves every row after it up one.
  const landing = findCell(without, besidePanelId);
  if (!landing) return [...rows];
  const next = without.map((row) => ({ ...row, cells: [...row.cells] }));
  next[landing.row]!.cells.splice(side === 'before' ? landing.at : landing.at + 1, 0, {
    panelId,
    span,
  });
  // Its own span is what it carries along a row it was already on, so two
  // panels sharing a row 8/4 swap to 4/8 rather than flattening to 6/6.
  if (moving.row !== target.row) next[landing.row]!.cells = evenly(next[landing.row]!.cells);
  return next;
}

/**
 * The arrangement with one panel put on a row of its own, in the gap at `at`.
 *
 * **`at` is the gap as it is drawn**: 0 is above the first row, `rows.length`
 * is below the last, and `n` is between rows `n - 1` and `n`. That is the only
 * number a drop target can honestly report - it knows where the pointer is, not
 * what the list will look like once the panel has left it.
 *
 * Taking the panel out can drop the row it was in, which moves every gap below
 * that row up one, so a gap below it means one row less than it said. Doing
 * that arithmetic here rather than at the call site is the difference between
 * dragging a panel *down* landing where the pointer is and landing one row
 * short - and a drop target is exactly where that mistake would not be noticed.
 */
export function movedToOwnRow(
  rows: readonly LayoutRow[],
  panelId: string,
  at: number,
): LayoutRow[] {
  const moving = findCell(rows, panelId);
  if (!moving) return [...rows];
  const without = withoutPanel(rows, panelId);
  const emptiedItsRow = without.length < rows.length;
  const where = clamp(emptiedItsRow && at > moving.row ? at - 1 : at, 0, without.length);
  // Already alone on that line, and the gesture asked for the line it is on:
  // nothing to do, and doing it anyway would send a change that moved nothing.
  if (emptiedItsRow && moving.row === where) return [...rows];
  const next = without.map((row) => ({ ...row, cells: [...row.cells] }));
  next.splice(where, 0, {
    height: null,
    cells: [{ panelId, span: DEFAULT_CELL_SPAN }],
  });
  return next;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, Number.isFinite(value) ? value : low));
}

/**
 * The arrangement with a whole row moved to another place among the rows.
 *
 * The row is carried as it is - its height, its panels and their shares - so
 * moving it changes the order of the lines and nothing about any of them.
 * `to` is the row's place in the arrangement that comes out, and is clamped
 * to one that exists; a `from` that is no row leaves the arrangement alone.
 */
export function movedRow(rows: readonly LayoutRow[], from: number, to: number): LayoutRow[] {
  const moving = rows[from];
  if (!moving) return [...rows];
  const next = rows.filter((_, at) => at !== from);
  next.splice(clamp(to, 0, next.length), 0, moving);
  return next;
}

/** Whether two arrangements say the same thing, so nothing is sent when nothing moved. */
export function sameArrangement(
  one: readonly LayoutRow[],
  other: readonly LayoutRow[],
): boolean {
  return (
    one.length === other.length &&
    one.every((row, at) => {
      const against = other[at]!;
      return (
        row.height === against.height &&
        row.title === against.title &&
        row.cells.length === against.cells.length &&
        row.cells.every((cell, where) => {
          const facing = against.cells[where]!;
          return cell.panelId === facing.panelId && cell.span === facing.span;
        })
      );
    })
  );
}

/**
 * The arrangement with one row given a height, or given none.
 *
 * **The bounds live here rather than in the gesture**, so a height is in range
 * by the time anything can hold one: the board hands over whatever the pointer
 * says and gets back a row a screen can draw. A height outside them is clamped
 * rather than refused, because the pointer is always allowed to keep going -
 * the row simply stops, which is what a person sees and reads as the limit.
 *
 * `null` is not a height and passes straight through: it is a row going back to
 * being as tall as what is in it, which is what a row is until somebody says
 * otherwise.
 */
export function withRowHeight(
  rows: readonly LayoutRow[],
  rowIndex: number,
  height: number | null,
): LayoutRow[] {
  const kept = height === null ? null : Math.round(clamp(height, MIN_ROW_HEIGHT, MAX_ROW_HEIGHT));
  // A Section's height is fixed, so it is never given one.
  return rows.map((row, at) =>
    at === rowIndex && !rowIsSection(row)
      ? { height: kept, cells: row.cells.map((cell) => ({ ...cell })) }
      : row,
  );
}

/**
 * A row's spans as whole twelfths of it, drawing exactly the proportions it
 * already has.
 *
 * A divider moves whole columns between two neighbours, so the row has to add
 * up to twelve before one can be moved within it - and a row nobody has ever
 * dragged is twelve per cell, which is the same proportions and not a total
 * anything can be moved inside. Largest-remainder, so the twelve are shared out
 * as close to the proportions as whole numbers get, and no cell is ever given
 * less than the one column `cellInputSchema` allows.
 *
 * A row of more cells than there are columns cannot be written this way at all -
 * twelve columns will not give thirteen cells one each - and comes back as it
 * is. Only a converted arrangement can be that wide, `MOST_ACROSS` being four.
 */
function inTwelfths(row: LayoutRow): number[] {
  const count = row.cells.length;
  if (count === 0 || count > GRID_COLUMNS) return row.cells.map((cell) => cell.span);
  const wanted = sharesOf(row).map((share) => share * GRID_COLUMNS);
  const spans = wanted.map((value) => Math.max(1, Math.floor(value)));
  const byRemainder = wanted
    .map((value, at) => ({ at, rest: value - Math.floor(value) }))
    .sort((one, other) => other.rest - one.rest);
  let left = GRID_COLUMNS - spans.reduce((sum, span) => sum + span, 0);
  for (let step = 0; left > 0; step += 1) {
    const at = byRemainder[step % count]!.at;
    spans[at] = spans[at]! + 1;
    left -= 1;
  }
  // Flooring at one can overshoot twelve on a row of many narrow cells; the
  // columns come back off the widest, which is the cell that can spare them.
  while (left < 0) {
    const widest = spans.indexOf(Math.max(...spans));
    if (spans[widest]! <= 1) break;
    spans[widest] = spans[widest]! - 1;
    left += 1;
  }
  return spans;
}

/**
 * The arrangement with whole columns moved across one of a row's dividers: the
 * panel on the left of it gains exactly what the panel on the right loses.
 *
 * **The row still adds up to a whole**, so the panels either side of the pair
 * keep the share they had - a divider is a question about two neighbours, not
 * about the row.
 *
 * **A move of no columns changes nothing at all**, and that is not a shortcut:
 * writing the row in twelfths would rewrite every span of a row nobody has
 * dragged (twelve per cell becomes four per cell on a row of three) for the
 * same proportions, and a gesture that ends where it started would be kept as a
 * change. The rewrite happens only once a column actually moves.
 *
 * Neither neighbour can be squeezed out: a panel stops at the one column
 * `cellInputSchema` allows, which is a twelfth of the row.
 */
export function dividerMoved(
  rows: readonly LayoutRow[],
  rowIndex: number,
  dividerAt: number,
  columns: number,
): LayoutRow[] {
  const row = rows[rowIndex];
  if (!row || columns === 0) return [...rows];
  if (dividerAt < 0 || dividerAt + 1 >= row.cells.length) return [...rows];
  if (row.cells.length > GRID_COLUMNS) return [...rows];
  const spans = inTwelfths(row);
  const pair = spans[dividerAt]! + spans[dividerAt + 1]!;
  const takes = Math.round(clamp(spans[dividerAt]! + columns, 1, pair - 1));
  spans[dividerAt] = takes;
  spans[dividerAt + 1] = pair - takes;
  return rows.map((one, at) =>
    at === rowIndex
      ? { height: one.height, cells: one.cells.map((cell, where) => ({ ...cell, span: spans[where]! })) }
      : one,
  );
}
