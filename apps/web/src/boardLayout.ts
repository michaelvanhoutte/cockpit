import type { WorkspaceSnapshot } from '@cockpit/shared';
import type { DashboardView } from '@cockpit/shared/board';

/**
 * How a Dashboard is laid out ("Brainstorming: give every Dashboard a
 * whiteboard of its own", issue 1829): its Panels alone, Panels and whiteboard
 * side by side or stacked, or the whiteboard alone, and where the divider
 * between them sits, remembered per Dashboard in the Workspace's read. A
 * Dashboard never switched shows its Panels, with the divider at 40%.
 */
export function boardLayoutOf(snapshot: WorkspaceSnapshot | undefined, dashboardId: string): { view: DashboardView; splitShare: number } {
  const chosen = snapshot?.whiteboards?.layouts.find((one) => one.dashboardId === dashboardId);
  return { view: chosen?.view ?? 'panels', splitShare: chosen?.splitShare ?? 0.4 };
}
