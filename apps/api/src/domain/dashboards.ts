import { FIRST_DASHBOARD_NAME } from '@cockpit/shared';
import type { AddDashboardCommand, Dashboard } from '@cockpit/shared';
import { foldName, namedTheSame } from './names.js';

/**
 * Pure handlers for dashboards (architecture, "Hono + Zod on Cloudflare
 * Workers": domain imports nothing from the other layers).
 *
 * A dashboard is a named view inside one workspace ("Add and switch
 * dashboards", issue 32). The Inbox is not one of these: it is a fixture of the
 * screen rather than a row, so nothing here can name it, and nothing here has
 * to keep it first.
 */


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
  position: number;
  createdAt: string;
  deletedAt: string | null;
}

/**
 * Whether this is an order of exactly the dashboards the workspace has: every
 * one of them, once each, and nothing else.
 *
 * The same check `ordersExactly` makes for workspaces, one level down, and the
 * scope is the only thing it differs in: `live` is one workspace's dashboards,
 * so an order naming another workspace's is refused here rather than silently
 * moving a tab nobody was looking at ("Reorder a workspace's dashboards by
 * dragging their tabs", issue 503).
 */
export function ordersDashboardsExactly(
  live: readonly Dashboard[],
  order: readonly string[],
): boolean {
  const named = new Set(order);
  if (named.size !== order.length) return false;
  if (named.size !== live.length) return false;
  return live.every((dashboard) => named.has(dashboard.id));
}

/**
 * `createdAt` is the client's own timestamp, like every other command, so the
 * order dashboards sit in the bar is the order they were added in even when an
 * add was queued offline.
 *
 * `position` arrives the way it does for a workspace, and for the same reason:
 * it is a function of every dashboard the workspace already has, deleted ones
 * included, and only the store can see that whole set.
 */
export function dashboardFromCommand(
  cmd: AddDashboardCommand,
  tenantId: string,
  position: number,
): DashboardRow {
  return {
    id: cmd.dashboardId,
    tenantId,
    workspaceId: cmd.workspaceId,
    name: cmd.name,
    foldedName: foldName(cmd.name),
    position,
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
    // First in a bar that has nothing else in it yet.
    position: 0,
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
