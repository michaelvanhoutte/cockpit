import type { AddDashboardCommand, Dashboard } from '@cockpit/shared';
import { foldName, namedTheSame } from './names.js';

/**
 * Pure handlers for dashboards (architecture, "Hono + Zod on Cloudflare
 * Workers": domain imports nothing from the other layers).
 *
 * A dashboard is a named view inside one workspace ("Add and switch
 * dashboards", issue 32). The Inbox is not one of these: it is a fixed entry in
 * the bar rather than a row, so nothing here can name it, and nothing here has
 * to keep it first.
 */

/** What a workspace's first dashboard is called before anybody names one. */
export const FIRST_DASHBOARD_NAME = 'Dashboard 1';

/**
 * The live dashboard of *this workspace* already going by this name, or
 * undefined.
 *
 * The scope is the one thing this differs from workspaces in: `live` is the
 * dashboards of one workspace, not of the account, so two workspaces may each
 * have a Research and neither knows about the other's.
 */
export function dashboardNamed(
  live: readonly Dashboard[],
  name: string,
  except?: string,
): Dashboard | undefined {
  return namedTheSame(live, name, except);
}

export interface DashboardRow extends Dashboard {
  foldedName: string;
  createdAt: string;
  deletedAt: string | null;
}

/**
 * `createdAt` is the client's own timestamp, like every other command, so the
 * order dashboards sit in the bar is the order they were added in even when an
 * add was queued offline.
 */
export function dashboardFromCommand(cmd: AddDashboardCommand, tenantId: string): DashboardRow {
  return {
    id: cmd.dashboardId,
    tenantId,
    workspaceId: cmd.workspaceId,
    name: cmd.name,
    foldedName: foldName(cmd.name),
    createdAt: cmd.issuedAt,
    deletedAt: null,
  };
}

/**
 * The dashboard a workspace is created with, so that "every workspace has at
 * least one dashboard" holds from the moment the workspace exists rather than
 * from the next time somebody adds one.
 *
 * Its id is derived from the workspace's own rather than generated, which is
 * what the backfill in changes.ts does for the workspaces that were already
 * there - the same rule in both places, so a workspace's first dashboard has
 * the same id whether it was made before this landed or after.
 */
export function firstDashboardFor(
  workspace: { id: string; tenantId: string; createdAt: string },
): DashboardRow {
  return {
    id: firstDashboardId(workspace.id),
    tenantId: workspace.tenantId,
    workspaceId: workspace.id,
    name: FIRST_DASHBOARD_NAME,
    foldedName: foldName(FIRST_DASHBOARD_NAME),
    createdAt: workspace.createdAt,
    deletedAt: null,
  };
}

/**
 * The id of a workspace's first dashboard, derived from the workspace's own.
 *
 * Derived rather than generated so that a change which fails partway and is
 * applied again cannot produce a second dashboard that merely looks different
 * from the first - the second insert collides with the first on the primary key
 * instead of adding a row.
 */
export function firstDashboardId(workspaceId: string): string {
  return `${workspaceId}-dashboard-1`;
}
