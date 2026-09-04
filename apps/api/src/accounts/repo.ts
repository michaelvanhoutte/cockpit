import { and, asc, eq, inArray, isNull, max, ne } from 'drizzle-orm';
import type {
  Association,
  Dashboard,
  Filing,
  Item,
  Layout,
  Panel,
  Workspace,
} from '@cockpit/shared';
import type { AccountDb } from './client.js';
import type { PlacementRow } from '../domain/panels.js';
import {
  associations,
  commands,
  dashboards,
  items,
  layouts,
  panelItems,
  panelPlacements,
  panels,
  workspaces,
} from './schema.js';

/**
 * Repositories: the only place queries live. Every query filters on tenant_id
 * (architecture, "Security": workspace scoping is enforced server-side, the
 * UI's scoping is presentation, not protection).
 *
 * The filter is not redundant now that a store holds exactly one account. It is
 * what turns a request that reached the wrong store into no rows rather than
 * somebody else's items - see "One store per account, and `tenant_id` stays".
 */

/**
 * The columns a workspace is read by: exactly the wire shape, named one by one.
 *
 * **Spelled out rather than left to a bare `select()`, and that is the whole
 * point of it.** Drizzle builds a bare `select()`'s field list from every
 * column declared on the table, so the SQL it sends names each one - including
 * the ones this service has no use for. Measured, not assumed: it emitted
 * `select "id", "tenant_id", "name", "folded_name", "slug", "color",
 * "created_at", "deleted_at" from "workspaces"`.
 *
 * That is what makes dropping a column a two-release job rather than one, and
 * naming the columns here is the first of those releases. A column this list
 * does not mention can be dropped by a later release without the code running
 * at that moment - which is this one - ever noticing. Drop one out from under a
 * bare `select()` and every read of the table fails instead, which is not a
 * degraded workspace list: it is no page at all.
 *
 * So: add a column here only when something reads it, and take it out one
 * release before the migration that drops it. The rule has a test -
 * "a workspace is read by the columns it is read by" in
 * tests/integration/accounts/workspace-reads.test.ts - which drops a column nothing
 * needs and asks for a workspace anyway.
 */
const workspaceColumns = {
  id: workspaces.id,
  tenantId: workspaces.tenantId,
  name: workspaces.name,
  color: workspaces.color,
  bar: workspaces.bar,
  ground: workspaces.ground,
  header: workspaces.header,
};

/** A deleted workspace is tombstoned, so every read of one filters it out. */
const live = (tenantId: string) =>
  and(eq(workspaces.tenantId, tenantId), isNull(workspaces.deletedAt));

/**
 * Every live workspace, in the order they sit in the tabs ("Reorder
 * workspaces", issue 31).
 *
 * The order is carried by the array and not by a field of it, which is why
 * `position` is absent from the columns above and named here instead: nothing
 * outside this ordering reads it, and a client that had it would only be able
 * to get it wrong. `created_at` breaks a tie, so two workspaces that somehow
 * share a position are still in a stable order rather than whichever one
 * SQLite reaches first.
 *
 * `position` is therefore a column this file *reads*, unlike `folded_name`, and
 * the two-release rule in the comment above applies to it in full: taking it
 * out from under this ORDER BY is a failed read, not a degraded one. A
 * qualified `"workspaces"."position"` raises "no such column" rather than
 * falling back to a string literal the way a bare quoted name does.
 */
export function listWorkspaces(db: AccountDb, tenantId: string): Workspace[] {
  return db
    .select(workspaceColumns)
    .from(workspaces)
    .where(live(tenantId))
    .orderBy(workspaces.position, workspaces.createdAt)
    .all();
}

/**
 * The highest position any of this account's workspaces holds, or null when it
 * has none at all - so a new one can be put after every workspace there is.
 *
 * Deleted workspaces count. They are filtered out of every read, so reusing
 * their positions would be harmless; not reusing them is one fewer thing to
 * hold in mind, and it keeps the numbers of an account's workspaces telling the
 * truth about the order they were in.
 */
export function lastWorkspacePosition(db: AccountDb, tenantId: string): number | null {
  const row = db
    .select({ highest: max(workspaces.position) })
    .from(workspaces)
    .where(eq(workspaces.tenantId, tenantId))
    .get();
  return row?.highest ?? null;
}

export function getWorkspace(
  db: AccountDb,
  tenantId: string,
  workspaceId: string,
): Workspace | null {
  return (
    db
      .select(workspaceColumns)
      .from(workspaces)
      .where(and(live(tenantId), eq(workspaces.id, workspaceId)))
      .get() ?? null
  );
}

/**
 * The columns a dashboard is read by, named one by one for the reason the
 * workspace ones are: a bare `select()` names every column of the table, which
 * makes dropping one a two-release job. `folded_name` is deliberately not among
 * them - nothing outside the index reads it.
 */
const dashboardColumns = {
  id: dashboards.id,
  tenantId: dashboards.tenantId,
  workspaceId: dashboards.workspaceId,
  name: dashboards.name,
};

/**
 * A workspace's dashboards, oldest first, which is the order they sit in the
 * bar. Tombstoned ones are left out the way tombstoned workspaces are.
 */
export function listDashboards(
  db: AccountDb,
  tenantId: string,
  workspaceId: string,
): Dashboard[] {
  return db
    .select(dashboardColumns)
    .from(dashboards)
    .where(
      and(
        eq(dashboards.tenantId, tenantId),
        eq(dashboards.workspaceId, workspaceId),
        isNull(dashboards.deletedAt),
      ),
    )
    .orderBy(dashboards.createdAt)
    .all();
}

/** One live dashboard of one workspace, or null - the check every panel change starts from. */
export function getDashboard(
  db: AccountDb,
  tenantId: string,
  workspaceId: string,
  dashboardId: string,
): Dashboard | null {
  return (
    db
      .select(dashboardColumns)
      .from(dashboards)
      .where(
        and(
          eq(dashboards.tenantId, tenantId),
          eq(dashboards.workspaceId, workspaceId),
          eq(dashboards.id, dashboardId),
          isNull(dashboards.deletedAt),
        ),
      )
      .get() ?? null
  );
}

/**
 * The columns a panel is read by, named one by one for the reason the workspace
 * and dashboard ones are: a bare `select()` names every column of the table,
 * which makes dropping one a two-release job. `folded_name` is deliberately not
 * among them - nothing outside the index reads it.
 */
const panelColumns = {
  id: panels.id,
  tenantId: panels.tenantId,
  dashboardId: panels.dashboardId,
  name: panels.name,
};

/**
 * A dashboard's panels, oldest first, which is the order they are drawn in
 * before the dashboard has a layout. Tombstoned ones are left out the way
 * tombstoned dashboards are.
 */
export function listPanels(db: AccountDb, tenantId: string, dashboardId: string): Panel[] {
  return db
    .select(panelColumns)
    .from(panels)
    .where(
      and(
        eq(panels.tenantId, tenantId),
        eq(panels.dashboardId, dashboardId),
        isNull(panels.deletedAt),
      ),
    )
    .orderBy(panels.createdAt)
    .all();
}

/** One live panel, wherever it sits. Its `dashboardId` is what the changes to it scope by. */
export function getPanel(db: AccountDb, tenantId: string, panelId: string): Panel | null {
  return (
    db
      .select(panelColumns)
      .from(panels)
      .where(and(eq(panels.tenantId, tenantId), eq(panels.id, panelId), isNull(panels.deletedAt)))
      .get() ?? null
  );
}

/**
 * Every live panel of every live dashboard of one workspace, oldest first.
 *
 * The workspace rather than the dashboard, because that is the scope of the
 * snapshot: the client switches between a workspace's dashboards without a
 * round trip (architecture, "The read model: persisted snapshot, revalidate,
 * push"), so all of them arrive together or switching would go to the network.
 *
 * The join is on the dashboard's tombstone as well as the panel's. A panel of a
 * deleted dashboard is not on any screen there is, and leaving it in would let
 * the dashboard settings page count panels nobody can reach.
 */
export function listPanelsInWorkspace(
  db: AccountDb,
  tenantId: string,
  workspaceId: string,
): Panel[] {
  return db
    .select(panelColumns)
    .from(panels)
    .innerJoin(dashboards, eq(panels.dashboardId, dashboards.id))
    .where(
      and(
        eq(panels.tenantId, tenantId),
        eq(dashboards.workspaceId, workspaceId),
        isNull(panels.deletedAt),
        isNull(dashboards.deletedAt),
      ),
    )
    .orderBy(panels.createdAt)
    .all();
}

/** One layout, or null. Layouts are deleted rather than tombstoned, so there is nothing to filter. */
export function getLayout(
  db: AccountDb,
  tenantId: string,
  layoutId: string,
): { id: string; dashboardId: string; screenWidth: number } | null {
  return (
    db
      .select({
        id: layouts.id,
        dashboardId: layouts.dashboardId,
        screenWidth: layouts.screenWidth,
      })
      .from(layouts)
      .where(and(eq(layouts.tenantId, tenantId), eq(layouts.id, layoutId)))
      .get() ?? null
  );
}

/** The ids of one dashboard's layouts, which is all a new panel needs to reach every one of them. */
export function listLayoutIds(db: AccountDb, tenantId: string, dashboardId: string): string[] {
  return db
    .select({ id: layouts.id })
    .from(layouts)
    .where(and(eq(layouts.tenantId, tenantId), eq(layouts.dashboardId, dashboardId)))
    .orderBy(layouts.createdAt)
    .all()
    .map((row) => row.id);
}

/** One layout's arrangement, in the order it is drawn in. */
export function listPlacements(db: AccountDb, tenantId: string, layoutId: string): PlacementRow[] {
  return db
    .select({
      tenantId: panelPlacements.tenantId,
      layoutId: panelPlacements.layoutId,
      panelId: panelPlacements.panelId,
      position: panelPlacements.position,
      columnSpan: panelPlacements.columnSpan,
      rowSpan: panelPlacements.rowSpan,
    })
    .from(panelPlacements)
    .where(and(eq(panelPlacements.tenantId, tenantId), eq(panelPlacements.layoutId, layoutId)))
    // The panel id as a second key, so two rows that somehow share a position
    // still come back in the same order twice rather than in whichever order
    // the table happens to hand them over.
    .orderBy(asc(panelPlacements.position), asc(panelPlacements.panelId))
    .all();
}

/**
 * Every layout of every live dashboard of one workspace, each carrying its own
 * arrangement.
 *
 * Two queries rather than one join, and assembled here: a join would repeat
 * every layout once per placement and the rows would have to be regrouped
 * anyway, and this way a workspace whose dashboards have no layouts at all -
 * which is every workspace until somebody drags something - costs one query and
 * stops.
 */
export function listLayoutsInWorkspace(
  db: AccountDb,
  tenantId: string,
  workspaceId: string,
): Layout[] {
  const found = db
    .select({
      id: layouts.id,
      tenantId: layouts.tenantId,
      dashboardId: layouts.dashboardId,
      screenWidth: layouts.screenWidth,
    })
    .from(layouts)
    .innerJoin(dashboards, eq(layouts.dashboardId, dashboards.id))
    .where(
      and(
        eq(layouts.tenantId, tenantId),
        eq(dashboards.workspaceId, workspaceId),
        isNull(dashboards.deletedAt),
      ),
    )
    .orderBy(layouts.screenWidth)
    .all();
  if (found.length === 0) return [];

  // No filter on the panels being live, deliberately: deleting a panel takes
  // its placements with it in the same transaction (command-service.ts), so a
  // placement naming a deleted panel is not a state this store can be in. A
  // second filter here would be a branch nothing can reach, and the screen
  // drawing these already drops a placement whose panel is not in the snapshot
  // it holds - which is the case that really happens, in a browser looking at a
  // copy from before the delete.
  const arrangements = db
    .select({
      layoutId: panelPlacements.layoutId,
      panelId: panelPlacements.panelId,
      columns: panelPlacements.columnSpan,
      rows: panelPlacements.rowSpan,
    })
    .from(panelPlacements)
    .where(
      and(
        eq(panelPlacements.tenantId, tenantId),
        inArray(
          panelPlacements.layoutId,
          found.map((layout) => layout.id),
        ),
      ),
    )
    .orderBy(asc(panelPlacements.position), asc(panelPlacements.panelId))
    .all();

  return found.map((layout) => ({
    ...layout,
    placements: arrangements
      .filter((placement) => placement.layoutId === layout.id)
      .map(({ panelId, columns, rows }) => ({ panelId, columns, rows })),
  }));
}

/**
 * The columns an item is read by, named for the reason `workspaceColumns` above
 * is named: a bare `select()` names every column the table declares, so the
 * three dead ones would come back on every read and a later release could not
 * drop them without breaking this one.
 *
 * Here it does a second job. `status`, `focus_horizon` and `snoozed_until` are
 * no longer part of what an Item *is* ("An item is either yours to deal with or
 * finished with", issue 154), and leaving them out here is what makes that true
 * of the rows this returns rather than only of the type describing them.
 */
const itemColumns = {
  id: items.id,
  tenantId: items.tenantId,
  workspaceId: items.workspaceId,
  source: items.source,
  sourceId: items.sourceId,
  sourceLink: items.sourceLink,
  sender: items.sender,
  sourceTimestamp: items.sourceTimestamp,
  title: items.title,
  preview: items.preview,
  sourceResolvedAt: items.sourceResolvedAt,
  nextAction: items.nextAction,
  completedAt: items.completedAt,
  priority: items.priority,
  dueDate: items.dueDate,
  unseen: items.unseen,
  deletedAt: items.deletedAt,
  createdAt: items.createdAt,
  updatedAt: items.updatedAt,
};

/**
 * Open items: tombstoned rows stay in the store but never in the snapshot.
 *
 * **Dismissed items are left out here and finished ones are not**, which is
 * deliberate: a dismissed item is gone until something brings it back, while an
 * item marked done has to reach the browser for the bar offering to undo it to
 * have anything to put back ("Undo what just happened", issue 144). What keeps
 * a finished item off the lists is the client's own derivation.
 */
export function listOpenItems(db: AccountDb, tenantId: string, workspaceId: string): Item[] {
  return db
    .select(itemColumns)
    .from(items)
    .where(
      and(
        eq(items.tenantId, tenantId),
        eq(items.workspaceId, workspaceId),
        isNull(items.deletedAt),
      ),
    )
    .orderBy(items.createdAt)
    .all();
}

export function getItem(db: AccountDb, tenantId: string, itemId: string): Item | null {
  return (
    db
      .select(itemColumns)
      .from(items)
      .where(and(eq(items.tenantId, tenantId), eq(items.id, itemId)))
      .get() ?? null
  );
}

export function listAssociationsForWorkspace(
  db: AccountDb,
  tenantId: string,
  workspaceId: string,
): Association[] {
  return db
    .select({
      id: associations.id,
      tenantId: associations.tenantId,
      itemId: associations.itemId,
      kind: associations.kind,
      label: associations.label,
      createdAt: associations.createdAt,
    })
    .from(associations)
    .innerJoin(items, eq(associations.itemId, items.id))
    .where(and(eq(associations.tenantId, tenantId), eq(items.workspaceId, workspaceId)))
    .all();
}

/**
 * Every filing in one workspace: which items are on which of its panels, and
 * where each sits ("Panels hold the items filed into them, and the Inbox holds
 * the rest", issue 36).
 *
 * **Filings of deleted panels and deleted dashboards are left out**, which is
 * what puts an item back in the Inbox when the last panel holding it goes. The
 * rows stay - a panel is tombstoned, so its filings still point at something
 * real - and the join is what stops them being read. That is the same shape
 * `listPanelsInWorkspace` has, and reading them the same way is what keeps the
 * two answers agreeing about which panels exist.
 *
 * The item is joined too, and on its workspace: a panel names its dashboard,
 * never a workspace, so without it a filing of another workspace's item onto
 * this workspace's panel would be read here.
 */
export function listFilingsInWorkspace(
  db: AccountDb,
  tenantId: string,
  workspaceId: string,
): Filing[] {
  return db
    .select({
      panelId: panelItems.panelId,
      itemId: panelItems.itemId,
      position: panelItems.position,
    })
    .from(panelItems)
    .innerJoin(panels, eq(panelItems.panelId, panels.id))
    .innerJoin(dashboards, eq(panels.dashboardId, dashboards.id))
    .innerJoin(items, eq(panelItems.itemId, items.id))
    .where(
      and(
        eq(panelItems.tenantId, tenantId),
        eq(dashboards.workspaceId, workspaceId),
        eq(items.workspaceId, workspaceId),
        isNull(panels.deletedAt),
        isNull(dashboards.deletedAt),
      ),
    )
    .orderBy(asc(panelItems.position))
    .all();
}

/**
 * The items filed on one panel, in order — what an order sent with a move is
 * checked against, so that an order which no longer names the panel's items is
 * refused rather than quietly written.
 *
 * Deleted panels are not filtered here: the caller has already established
 * which panel this is, and a deleted one has no filings to compare against
 * anyway.
 */
export function listFilingsOnPanel(db: AccountDb, tenantId: string, panelId: string): Filing[] {
  return db
    .select({
      panelId: panelItems.panelId,
      itemId: panelItems.itemId,
      position: panelItems.position,
    })
    .from(panelItems)
    .where(and(eq(panelItems.tenantId, tenantId), eq(panelItems.panelId, panelId)))
    .orderBy(asc(panelItems.position))
    .all();
}

export function commandAlreadyApplied(db: AccountDb, commandId: string): boolean {
  return db.select().from(commands).where(eq(commands.commandId, commandId)).all().length > 0;
}
