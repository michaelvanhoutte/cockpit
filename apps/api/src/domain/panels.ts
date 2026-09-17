import {
  DEFAULT_CELL_SPAN,
  FIRST_PANEL_NAME,
  NAME_MAX_LENGTH,
  panelFilterAsStored,
} from '@cockpit/shared';
import type {
  AddPanelCommand,
  Panel,
  PanelFormat,
  RowInput,
  SaveLayoutCommand,
  StoredPanelKind,
} from '@cockpit/shared';
import { foldName, namedTheSame } from './names.js';

/**
 * Pure handlers for panels and the layouts that arrange them (architecture,
 * "Hono + Zod on Cloudflare Workers": domain imports nothing from the other
 * layers).
 *
 * A panel is a titled box on one dashboard ("Panels on a dashboard, with
 * per-screen-size layouts", issue 33). A layout is one arrangement of that
 * dashboard's panels: a list of rows, each holding the panels across it ("Rows
 * of panels, not a grid that wraps").
 */


/**
 * The panel a dashboard arrives with, so that a workspace has somewhere to file
 * an item into from the moment it exists.
 *
 * **Every dashboard, not only a workspace's first.** The Inbox holds every open
 * item that no panel holds, so a workspace whose dashboards have no panels has
 * no way to take anything *out* of the Inbox - the drag has no target - and a
 * dashboard added later would recreate that one dashboard at a time.
 *
 * **A starting condition, not an invariant.** The last panel of a dashboard can
 * still be deleted and nothing puts one back, unlike the last dashboard of a
 * workspace, which is refused: a workspace with no dashboard has no view at
 * all, while a dashboard with no panels is one you can put a panel on.
 *
 * The id comes from the command rather than from the dashboard's, which is the
 * one thing this does not copy from `firstDashboardFor`: five commands take a
 * `panelId` as a uuid, so a derived id would leave this panel unable to be
 * renamed, deleted or filed into.
 */
export function firstPanelFor(
  dashboard: { id: string; tenantId: string; createdAt: string },
  panelId: string,
): PanelRow {
  return {
    id: panelId,
    tenantId: dashboard.tenantId,
    dashboardId: dashboard.id,
    name: FIRST_PANEL_NAME,
    foldedName: foldName(FIRST_PANEL_NAME),
    // The panel a dashboard arrives with is the one an item is filed into, so
    // it is a panel of items - and it holds no text and refuses none, being a
    // panel that has no text to hold.
    kind: 'items',
    format: 'plain',
    body: '',
    readOnly: false,
    // Not a Filter: a dashboard arrives with somewhere to file into, and a
    // Filter is the one Panel nothing can be filed onto.
    filterConditions: null,
    createdAt: dashboard.createdAt,
    deletedAt: null,
  };
}

/**
 * The live panel of *this dashboard* already going by this title, or undefined.
 *
 * The scope is the one thing this differs from dashboards in, and it is one
 * level further down: `live` is the panels of one dashboard, not of the
 * workspace, so two dashboards may each have a Reading list and neither knows
 * about the other's.
 */
export function panelNamed(
  live: readonly Panel[],
  name: string,
  except?: string,
): Panel | undefined {
  return namedTheSame(live, name, except);
}

/**
 * The name a panel keeps when it lands on a dashboard that already has one
 * going by its name - suffixed rather than refused, since a move is not a
 * request the mover can retype ("Move a panel to another dashboard, from its
 * menu or by dragging it onto a tab", issue 439).
 *
 * `Name`, then `Name (2)`, `Name (3)`… against the target's own live panels,
 * climbing past every number already taken there rather than stopping at the
 * first free one below a collision - so `Reading list (2)` moved onto a
 * dashboard that already has both `Reading list` and `Reading list (2)` lands
 * on `Reading list (3)` rather than colliding with the one already there.
 *
 * **A number the incoming name already carries is climbed past, not kept -
 * but only where it is plausibly this function's own, earlier suffix.**
 * `Reading list (2)` colliding again strips to `Reading list`, checks that
 * *that* is itself on the target, and climbs to `Reading list (3)` rather
 * than piling on `Reading list (2) (2)`. A title that merely ends in a
 * parenthesised number for its own reasons - `Sprint (2026)` - keeps every
 * character of it: stripping is only trusted where the number in front of it
 * is a real title already sitting on the target, found in review.
 *
 * **Capped the same as any other panel name** (`NAME_MAX_LENGTH`), which
 * nothing sends this one to be validated against: unlike `add_panel` and
 * `rename_panel`, the mover never types this name, so nothing upstream of
 * this function checks its length. Room is reserved for the suffix rather
 * than appended past the cap, found in review.
 */
export function panelNameForMove(target: readonly Panel[], name: string): string {
  if (!panelNamed(target, name)) return name;
  const stripped = name.replace(/ \(\d+\)$/, '');
  const base = panelNamed(target, stripped) ? stripped : name;
  // Six characters is room for " (2)" through " (999)" - more collisions on
  // one dashboard than a workspace could plausibly reach.
  const room = NAME_MAX_LENGTH - 6;
  const fitted = base.length > room ? base.slice(0, room) : base;
  let n = 2;
  while (panelNamed(target, `${fitted} (${n})`)) n += 1;
  return `${fitted} (${n})`;
}

/**
 * One panel as the store holds it, which is not quite what the wire carries: the
 * stored `kind` is one of the two the column may hold (`STORED_PANEL_KINDS`),
 * and what a Filter gathers is the text of a column rather than the shape a
 * reader gets back.
 */
export interface PanelRow {
  id: string;
  tenantId: string;
  dashboardId: string;
  name: string;
  foldedName: string;
  kind: StoredPanelKind;
  format: PanelFormat;
  body: string;
  readOnly: boolean;
  filterConditions: string | null;
  createdAt: string;
  deletedAt: string | null;
}

/**
 * `createdAt` is the client's own timestamp, like every other command, so the
 * order panels sit in on a dashboard with no layout yet is the order they were
 * added in even when an add was queued offline.
 *
 * **The kind comes from the command and is written once.** Nothing updates it
 * afterwards, which is the whole of "decided when it is made and never after"
 * (`panelKindSchema`): there is no command to change it, so there is no code
 * path that could.
 *
 * **A Filter is stored as a panel of items with its conditions set**, which is
 * the one place that translation happens on the way in - and it arrives with no
 * conditions, which is what makes a new one say so rather than gather
 * everything.
 */
export function panelFromCommand(cmd: AddPanelCommand, tenantId: string): PanelRow {
  return {
    id: cmd.panelId,
    tenantId,
    dashboardId: cmd.dashboardId,
    name: cmd.name,
    foldedName: foldName(cmd.name),
    kind: cmd.kind === 'filter' ? 'items' : cmd.kind,
    filterConditions: cmd.kind === 'filter' ? panelFilterAsStored([]) : null,
    // The characters as typed, until somebody asks for formatting: it is what
    // costs nothing to draw, and a panel with nothing in it has nothing to
    // format anyway.
    format: 'plain',
    body: '',
    /**
     * **Open, and it is the one panel of text that arrives so.** Read-only is
     * what a panel of text settles into - it is a thing to read, and it is how
     * the rest of them are found - but the panel somebody has just made is the
     * one place that would be nonsense: an empty box refusing to be written in,
     * one menu away from the gesture that made it.
     */
    readOnly: false,
    createdAt: cmd.issuedAt,
    deletedAt: null,
  };
}

/** One Panel's place in a layout: which row, where along it, and its share of it. */
export interface PlacementRow {
  tenantId: string;
  layoutId: string;
  panelId: string;
  rowIndex: number;
  position: number;
  span: number;
}

/** One row of a layout, and how tall it is - null being "as tall as what is in it". */
export interface LayoutRowRow {
  tenantId: string;
  layoutId: string;
  rowIndex: number;
  height: number | null;
}

/**
 * The rows and the placements one arrangement becomes.
 *
 * **Both orders are written down rather than inferred**, because there are two:
 * `rowIndex` says which row, `position` says where along it. The old shape had
 * one flat `position` and let CSS decide where the lines fell, which is exactly
 * what rows exist to stop.
 *
 * The indexes are used as written rather than renumbered from what was there
 * before, so an arrangement is always a whole answer and never a patch on one -
 * which is what makes saving the same layout twice land on the same rows.
 */
export function arrangementRows(
  tenantId: string,
  layoutId: string,
  rows: readonly RowInput[],
): { rows: LayoutRowRow[]; placements: PlacementRow[] } {
  const placements: PlacementRow[] = [];
  rows.forEach((row, rowIndex) => {
    row.cells.forEach((cell, position) => {
      placements.push({
        tenantId,
        layoutId,
        panelId: cell.panelId,
        rowIndex,
        position,
        span: cell.span,
      });
    });
  });
  return {
    rows: rows.map((row, rowIndex) => ({ tenantId, layoutId, rowIndex, height: row.height })),
    placements,
  };
}

/**
 * The values one row of each kind binds, which is what decides how many of them
 * fit in a statement (`inBatchesOf`). Counted from the interfaces above; a
 * column added there is a value added here.
 */
export const PLACEMENT_VALUES_PER_ROW = 6;
export const LAYOUT_ROW_VALUES_PER_ROW = 4;

/**
 * Where a newly added panel goes in a layout that already exists: in a row of
 * its own, under everything already there.
 *
 * **A row of its own rather than beside the last panel**, which is what the old
 * shape did by appending to a flat list. A row is a decision about what belongs
 * side by side, and nothing about adding a panel says it belongs beside any
 * particular one - so it gets a line, full width, where it is impossible to
 * miss and one drag from anywhere else. It also keeps a phone layout a phone
 * layout without having to copy anything: one panel across is what a row of one
 * *is*.
 */
export function appendedPlacement(
  tenantId: string,
  layoutId: string,
  panelId: string,
  existingRows: readonly LayoutRowRow[],
): { row: LayoutRowRow; placement: PlacementRow } {
  // Past the end of what is there. One past the last *index* rather than the
  // count, because the two part company the moment a row is removed: an
  // arrangement is written whole, but a layout read back mid-change need not
  // have contiguous indexes, and counting would collide with a row that exists.
  const rowIndex = (existingRows.at(-1)?.rowIndex ?? -1) + 1;
  return {
    row: { tenantId, layoutId, rowIndex, height: null },
    placement: { tenantId, layoutId, panelId, rowIndex, position: 0, span: DEFAULT_CELL_SPAN },
  };
}

/**
 * The panels an arrangement names that are not on the dashboard it claims to
 * arrange.
 *
 * Returned rather than thrown so the caller decides what a stranger means: it
 * is a 404 naming the first one, because "this panel is not on this dashboard"
 * is the same answer whether the panel was deleted a moment ago, belongs to
 * another dashboard, or was never real.
 */
export function panelsNotOn(
  live: readonly Panel[],
  cmd: SaveLayoutCommand,
): string[] {
  const known = new Set(live.map((panel) => panel.id));
  return cmd.rows
    .flatMap((row) => row.cells.map((cell) => cell.panelId))
    .filter((panelId) => !known.has(panelId));
}
