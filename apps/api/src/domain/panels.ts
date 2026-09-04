import { DEFAULT_PANEL_SIZE } from '@cockpit/shared';
import type { AddPanelCommand, Panel, PlacementInput, SaveLayoutCommand } from '@cockpit/shared';
import { foldName, namedTheSame } from './names.js';

/**
 * Pure handlers for panels and the layouts that arrange them (architecture,
 * "Hono + Zod on Cloudflare Workers": domain imports nothing from the other
 * layers).
 *
 * A panel is a titled box on one dashboard ("Panels on a dashboard, with
 * per-screen-size layouts", issue 33). A layout is one arrangement of that
 * dashboard's panels, and a placement is where one panel sits in one layout.
 */

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

export interface PanelRow extends Panel {
  foldedName: string;
  createdAt: string;
  deletedAt: string | null;
}

/**
 * `createdAt` is the client's own timestamp, like every other command, so the
 * order panels sit in on a dashboard with no layout yet is the order they were
 * added in even when an add was queued offline.
 */
export function panelFromCommand(cmd: AddPanelCommand, tenantId: string): PanelRow {
  return {
    id: cmd.panelId,
    tenantId,
    dashboardId: cmd.dashboardId,
    name: cmd.name,
    foldedName: foldName(cmd.name),
    createdAt: cmd.issuedAt,
    deletedAt: null,
  };
}

export interface PlacementRow {
  tenantId: string;
  layoutId: string;
  panelId: string;
  position: number;
  columnSpan: number;
  rowSpan: number;
}

/**
 * The rows one layout's arrangement becomes: the list's own order written down
 * as `position`, because nothing else carries it.
 *
 * The index is used as written rather than renumbered from what was there
 * before, so an arrangement is always a whole answer and never a patch on one -
 * which is what makes saving the same layout twice land on the same rows.
 */
export function placementRows(
  tenantId: string,
  layoutId: string,
  placements: readonly PlacementInput[],
): PlacementRow[] {
  return placements.map((placement, position) => ({
    tenantId,
    layoutId,
    panelId: placement.panelId,
    position,
    columnSpan: placement.columns,
    rowSpan: placement.rows,
  }));
}

/**
 * The values one placement row binds, which is what decides how many of them
 * fit in a statement (`inBatchesOf`). Counted from `PlacementRow` above; a
 * column added there is a value added here.
 */
export const PLACEMENT_VALUES_PER_ROW = 6;

/**
 * Where a newly added panel goes in a layout that already exists: last, at the
 * size of the panel already last in it.
 *
 * Copying rather than defaulting is what keeps a phone layout a phone layout. A
 * layout made at 480px has its panels a full twelve columns across, and a new
 * panel handed the default third of the grid would be 160px wide on the screen
 * it was supposed to fit - visibly wrong, and wrong in the layout you were not
 * looking at when you added it. With nothing to copy the default is the only
 * answer there is.
 */
export function appendedPlacement(
  tenantId: string,
  layoutId: string,
  panelId: string,
  existing: readonly PlacementRow[],
): PlacementRow {
  const last = existing.at(-1);
  return {
    tenantId,
    layoutId,
    panelId,
    // Past the end of what is there, so it is drawn last. One past the last
    // *position* rather than the count of rows, because the two part company
    // the moment a panel is deleted: deleting one removes its placement without
    // renumbering the survivors, so five panels minus two leaves three rows
    // holding positions 0, 3 and 4 - and counting would put the newcomer at 3,
    // beside a panel already there rather than after all of them.
    position: (last?.position ?? -1) + 1,
    columnSpan: last?.columnSpan ?? DEFAULT_PANEL_SIZE.columns,
    rowSpan: last?.rowSpan ?? DEFAULT_PANEL_SIZE.rows,
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
  return cmd.placements.map((p) => p.panelId).filter((panelId) => !known.has(panelId));
}
