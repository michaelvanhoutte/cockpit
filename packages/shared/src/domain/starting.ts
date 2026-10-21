/**
 * What the containers an account is handed are called before anybody names one
 * — numbered rather than descriptive, read by both apps (architecture.md §4.4,
 * "packages/shared: schema and command rationale", for the full rationale).
 */

export const FIRST_WORKSPACE_NAME = 'Workspace 1';
export const FIRST_DASHBOARD_NAME = 'Dashboard 1';
export const FIRST_PANEL_NAME = 'Panel 1';

/**
 * The id of a Workspace's first Dashboard, derived from the Workspace's own
 * rather than generated: a change that fails partway and is applied again
 * collides with the first insert on the primary key instead of adding a second
 * Dashboard. Shared because the tab draws a new Workspace with the same id the
 * server will give it ("Open a new Workspace the moment you add it", issue 1366).
 */
export function firstDashboardId(workspaceId: string): string {
  return `${workspaceId}-dashboard-1`;
}
