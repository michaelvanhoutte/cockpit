/**
 * Where a panel let go here would land: another dashboard's tab, or nowhere -
 * the drop `PanelBoard` reads before falling back to its own within-dashboard
 * arrangement ("Move a panel to another dashboard, from its menu or by
 * dragging it onto a tab", issue 439).
 *
 * Dropping on the tab of the dashboard already open is read as no target
 * rather than as the dashboard it already is: it is the same tab the drag
 * left from, and a drop there changes nothing about where the panel is.
 */

export interface TabRect {
  dashboardId: string;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export function dashboardTabAt(
  point: { x: number; y: number },
  tabs: readonly TabRect[],
  openDashboardId: string,
): string | null {
  // The right and bottom edges are exclusive, the same convention
  // `getBoundingClientRect` itself follows: two tabs flush against each other
  // share no pixel, so a point on the seam belongs to one of them rather than
  // matching both and silently favouring whichever `tabs` lists first.
  const hit = tabs.find(
    (tab) =>
      point.x >= tab.left && point.x < tab.right && point.y >= tab.top && point.y < tab.bottom,
  );
  if (!hit || hit.dashboardId === openDashboardId) return null;
  return hit.dashboardId;
}
