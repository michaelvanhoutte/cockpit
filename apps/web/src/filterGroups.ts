import { panelTakesItems } from '@cockpit/shared';
import type { Dashboard, Filing, FilterGrouping, Item, Layout, Panel } from '@cockpit/shared';
import { filingsThatFile } from './filing';
import { drawnRows } from './panels/arrangement';

/**
 * One heading of a grouped Filter panel and the rows under it ("Group a Filter
 * panel's items by the Dashboard or Panel they are filed on", issue 805).
 */
export interface FilterGroup {
  /** Stable across redraws: the Dashboard's or the Panel's id. */
  key: string;
  /** What the heading says first: the Dashboard's name, or the Panel's. */
  name: string;
  /** The Dashboard a Panel heading says after its name, fainter. Null on a Dashboard heading. */
  dashboardName: string | null;
  /** The Panel a Panel heading is, which a row under it leaves out of its "also in". Null on a Dashboard heading. */
  panelId: string | null;
  /** In the order the Filter sorts them, an Item filed on two Panels of the group once. */
  items: Item[];
}

/**
 * A Filter panel's rows split under a heading per Dashboard or per Panel, in
 * board order: Dashboards as the tabs run, and a Dashboard's Panels as its
 * Layout draws them, row by row and left to right.
 *
 * **An Item filed on two Panels is under both**, and under a Dashboard once
 * however many of its Panels it is on there. A group with no row is left out,
 * and so is every Item filed nowhere, which has no Panel or Dashboard to be
 * under; the caller still holds the distinct list, which is what counts.
 *
 * **`items` arrive in the Filter's sort and leave in it**: each group is the
 * list filtered, never re-sorted.
 *
 * **Every Dashboard of the Workspace, not the one on screen**: a Filter gathers
 * from all of them, so the board's own Panels alone would be missing groups.
 * A Dashboard never arranged is drawn in its Panels' own order, which is what
 * `drawnRows` gives with no Layout.
 */
export function groupFilterRows(
  items: readonly Item[],
  grouping: FilterGrouping,
  filings: readonly Filing[],
  panelsInWorkspace: readonly Panel[],
  dashboards: readonly Dashboard[],
  layouts: readonly Layout[],
): FilterGroup[] {
  if (grouping === 'none') return [];
  const filedOn = new Map<string, Set<string>>();
  for (const filing of filingsThatFile(filings, panelsInWorkspace)) {
    const held = filedOn.get(filing.panelId);
    if (held) held.add(filing.itemId);
    else filedOn.set(filing.panelId, new Set([filing.itemId]));
  }
  const groups: FilterGroup[] = [];
  for (const dashboard of dashboards) {
    const panels = orderedAsDrawn(
      panelsInWorkspace.filter((panel) => panel.dashboardId === dashboard.id && panelTakesItems(panel)),
      layouts.find((layout) => layout.dashboardId === dashboard.id) ?? null,
    );
    if (grouping === 'panel') {
      for (const panel of panels) {
        const here = items.filter((item) => filedOn.get(panel.id)?.has(item.id));
        if (here.length > 0) {
          groups.push({ key: panel.id, name: panel.name, dashboardName: dashboard.name, panelId: panel.id, items: here });
        }
      }
    } else {
      const here = items.filter((item) => panels.some((panel) => filedOn.get(panel.id)?.has(item.id)));
      if (here.length > 0) {
        groups.push({ key: dashboard.id, name: dashboard.name, dashboardName: null, panelId: null, items: here });
      }
    }
  }
  return groups;
}

/**
 * One Dashboard's Panels in the order its Layout draws them. The width only
 * decides how many an unarranged Dashboard fits across a row, never the order
 * they come in, so any one will do.
 */
function orderedAsDrawn(panels: readonly Panel[], layout: Layout | null): Panel[] {
  const byId = new Map(panels.map((panel) => [panel.id, panel]));
  return drawnRows(layout, panels, 1200).flatMap((row) =>
    row.cells.flatMap((cell) => byId.get(cell.panelId) ?? []),
  );
}
