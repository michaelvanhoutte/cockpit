import { alias } from 'drizzle-orm/sqlite-core';
import { and, asc, desc, eq, exists, gt, isNotNull, isNull, max, ne, notExists, or, sql } from 'drizzle-orm';
import type { Column } from 'drizzle-orm';
import {
  REWRITE_HISTORY_LIMIT,
  type Association,
  type Attachment,
  type Dashboard,
  type Filing,
  type Item,
  type ItemType,
  type Layout,
  type LayoutRow,
  type Panel,
  type PossibleDuplicate,
  type RewriteAttemptStatus,
  type RoutingSummary,
  type ScreenSize,
  type Workspace,
} from '@cockpit/shared';
import type { AccountDb } from './client.js';
import type { AttachmentForDownload, AttachmentRow } from '../domain/attachments.js';
import type { LayoutRowRow, PlacementRow } from '../domain/panels.js';
import type { DecisionHistoryEntry } from '../domain/decision-history.js';
import type { JudgeableItem, TextCorrectionEntry } from '../domain/text-corrections.js';
import type { PinnedExampleEntry } from '../domain/pinned-text-examples.js';
import type { QueuedRewriteAttempt, RewriteHistoryEntryRow, RewriteOutcome } from '../domain/rewrite-history.js';
import {
  accountTextRules,
  associations,
  attachments,
  commands,
  dashboards,
  decisionHistory,
  duplicateSettlements,
  itemDuplicates,
  itemMeanings,
  items,
  itemTypes,
  layoutRows,
  layouts,
  panelItems,
  panelPlacements,
  panels,
  pinnedTextExamples,
  rewriteHistory,
  screenSizes,
  textCorrections,
  workspaceRoutingSummary,
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
  // What the panel is made of, what it holds when that is text, how those
  // words are drawn, and whether they are written in. Every screen that draws a
  // panel reads all of them, so they travel in the snapshot like the name does.
  kind: panels.kind,
  format: panels.format,
  body: panels.body,
  readOnly: panels.readOnly,
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
 * the list of dashboards count panels nobody can reach.
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
): { id: string; dashboardId: string } | null {
  return (
    db
      .select({ id: layouts.id, dashboardId: layouts.dashboardId })
      .from(layouts)
      .where(and(eq(layouts.tenantId, tenantId), eq(layouts.id, layoutId)))
      .get() ?? null
  );
}

/**
 * One dashboard's layouts, oldest first - which screen sizes it has already
 * defined a layout at, for `save_layout`'s "at most one per screen size" check.
 */
export function listLayoutsOn(
  db: AccountDb,
  tenantId: string,
  dashboardId: string,
): { id: string; screenSizeId: string }[] {
  return db
    .select({ id: layouts.id, screenSizeId: layouts.screenSizeId })
    .from(layouts)
    .where(and(eq(layouts.tenantId, tenantId), eq(layouts.dashboardId, dashboardId)))
    .orderBy(layouts.createdAt)
    .all();
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

/**
 * One layout's rows, in order. What a panel being added needs: it goes in a row
 * of its own under everything already there, so the last index is the question.
 */
export function listLayoutRows(
  db: AccountDb,
  tenantId: string,
  layoutId: string,
): LayoutRowRow[] {
  return db
    .select({
      tenantId: layoutRows.tenantId,
      layoutId: layoutRows.layoutId,
      rowIndex: layoutRows.rowIndex,
      height: layoutRows.height,
    })
    .from(layoutRows)
    .where(and(eq(layoutRows.tenantId, tenantId), eq(layoutRows.layoutId, layoutId)))
    .orderBy(asc(layoutRows.rowIndex))
    .all();
}

/** One layout's cells, in the order they are drawn in: by row, then along it. */
export function listPlacements(db: AccountDb, tenantId: string, layoutId: string): PlacementRow[] {
  return db
    .select({
      tenantId: panelPlacements.tenantId,
      layoutId: panelPlacements.layoutId,
      panelId: panelPlacements.panelId,
      rowIndex: panelPlacements.rowIndex,
      position: panelPlacements.position,
      span: panelPlacements.span,
    })
    .from(panelPlacements)
    .where(and(eq(panelPlacements.tenantId, tenantId), eq(panelPlacements.layoutId, layoutId)))
    // The panel id as a last key, so two cells that somehow share a place in a
    // row still come back in the same order twice rather than in whichever
    // order the table happens to hand them over.
    .orderBy(
      asc(panelPlacements.rowIndex),
      asc(panelPlacements.position),
      asc(panelPlacements.panelId),
    )
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
 *
 * Ordered by the screen size's own width, narrowest first - the same order
 * screen sizes are already offered in (`listScreenSizes`) - rather than by a
 * width `layouts` no longer carries.
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
      screenSizeId: layouts.screenSizeId,
    })
    .from(layouts)
    .innerJoin(dashboards, eq(layouts.dashboardId, dashboards.id))
    .innerJoin(screenSizes, eq(layouts.screenSizeId, screenSizes.id))
    .where(
      and(
        eq(layouts.tenantId, tenantId),
        eq(dashboards.workspaceId, workspaceId),
        isNull(dashboards.deletedAt),
      ),
    )
    .orderBy(screenSizes.width)
    .all();
  if (found.length === 0) return [];

  // Reached by the same join as the layouts above rather than by naming the
  // ids just found. Naming them bound one variable per layout, which SQLite
  // refuses past a limit - and it refused the *whole* workspace read, so a
  // workspace stopped painting entirely once it had accumulated enough layouts,
  // which is a dashboard per screen size and nothing unusual. The join binds
  // the workspace and nothing that grows.
  //
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
      rowIndex: panelPlacements.rowIndex,
      position: panelPlacements.position,
      span: panelPlacements.span,
    })
    .from(panelPlacements)
    .innerJoin(layouts, eq(panelPlacements.layoutId, layouts.id))
    .innerJoin(dashboards, eq(layouts.dashboardId, dashboards.id))
    .where(
      and(
        eq(panelPlacements.tenantId, tenantId),
        eq(dashboards.workspaceId, workspaceId),
        isNull(dashboards.deletedAt),
      ),
    )
    .orderBy(
      asc(panelPlacements.rowIndex),
      asc(panelPlacements.position),
      asc(panelPlacements.panelId),
    )
    .all();

  const heights = db
    .select({
      layoutId: layoutRows.layoutId,
      rowIndex: layoutRows.rowIndex,
      height: layoutRows.height,
    })
    .from(layoutRows)
    .innerJoin(layouts, eq(layoutRows.layoutId, layouts.id))
    .innerJoin(dashboards, eq(layouts.dashboardId, dashboards.id))
    .where(
      and(
        eq(layoutRows.tenantId, tenantId),
        eq(dashboards.workspaceId, workspaceId),
        isNull(dashboards.deletedAt),
      ),
    )
    .orderBy(asc(layoutRows.rowIndex))
    .all();

  return found.map((layout) => ({
    ...layout,
    rows: rowsOf(
      heights.filter((row) => row.layoutId === layout.id),
      arrangements.filter((cell) => cell.layoutId === layout.id),
    ),
  }));
}

/**
 * One layout's rows, assembled from the two lists that carry them.
 *
 * **The rows are what the arrangement is**, so a row with no cells is dropped
 * rather than drawn: a save writes both lists in one transaction and never
 * leaves an empty one behind, but a row whose only panel was deleted is exactly
 * that state, and a blank line on the dashboard is not what a deleted panel
 * should look like.
 *
 * Both lists arrive ordered, so this only groups.
 */
function rowsOf(
  heights: readonly { rowIndex: number; height: number | null }[],
  cells: readonly { panelId: string; rowIndex: number; span: number }[],
): LayoutRow[] {
  return heights
    .map((row) => ({
      height: row.height,
      cells: cells
        .filter((cell) => cell.rowIndex === row.rowIndex)
        .map(({ panelId, span }) => ({ panelId, span })),
    }))
    .filter((row) => row.cells.length > 0);
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
  workspaceDecided: items.workspaceDecided,
  source: items.source,
  sourceId: items.sourceId,
  sourceLink: items.sourceLink,
  sender: items.sender,
  sourceTimestamp: items.sourceTimestamp,
  capturedMessage: items.capturedMessage,
  title: items.title,
  description: items.description,
  textsSettledAt: items.textsSettledAt,
  textsProposedAt: items.textsProposedAt,
  readings: items.readings,
  proposedPanelId: items.proposedPanelId,
  proposedPanelReason: items.proposedPanelReason,
  sourceResolvedAt: items.sourceResolvedAt,
  typeId: items.typeId,
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
 *
 * **Plus every item belonging to no workspace yet** ("Capture something before
 * you know which workspace it belongs to", issue 165): it is not clear where
 * one goes, so it is offered in every workspace's Inbox until somebody says.
 * The `or` sits inside the `and` rather than beside it, which is the whole of
 * the care this needs - hoisted out, it would return every tenant's dismissed
 * undecided items along with this workspace's own.
 */
export function listOpenItems(db: AccountDb, tenantId: string, workspaceId: string): Item[] {
  return db
    .select(itemColumns)
    .from(items)
    .where(
      and(
        eq(items.tenantId, tenantId),
        or(eq(items.workspaceId, workspaceId), eq(items.workspaceDecided, false)),
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
    // **The same items `listOpenItems` returns**, which is why this carries the
    // same `or`: an item belonging to no workspace is drawn in every workspace,
    // and a row drawn without the associations it has is a row saying something
    // untrue about itself.
    .where(
      and(
        eq(associations.tenantId, tenantId),
        or(eq(items.workspaceId, workspaceId), eq(items.workspaceDecided, false)),
      ),
    )
    .all();
}

/**
 * Every file attached to an Item of one Workspace ("Attach a file to an
 * item", issue 441) - metadata only, the same columns `attachmentSchema`
 * (`@cockpit/shared`) reads back and never the bytes, which live in R2.
 *
 * The same join and the same `or` `listAssociationsForWorkspace` above
 * carries, for the same reason: an Item belonging to no workspace yet is
 * drawn in every workspace's Inbox, so its attachments ride along with it.
 *
 * **Unlike that one, this excludes a dismissed Item's own** - deliberately,
 * where the other reads it as an existing gap rather than a convention to
 * copy: `listOpenItems` (the `items` this same snapshot carries) already
 * excludes a dismissed Item, and an attachment naming one absent from
 * `items` is a dangling reference nothing downstream expects.
 */
export function listAttachmentsInWorkspace(
  db: AccountDb,
  tenantId: string,
  workspaceId: string,
): Attachment[] {
  return db
    .select({
      id: attachments.id,
      tenantId: attachments.tenantId,
      itemId: attachments.itemId,
      filename: attachments.filename,
      size: attachments.size,
      contentType: attachments.contentType,
      createdAt: attachments.createdAt,
    })
    .from(attachments)
    .innerJoin(items, eq(attachments.itemId, items.id))
    .where(
      and(
        eq(attachments.tenantId, tenantId),
        or(eq(items.workspaceId, workspaceId), eq(items.workspaceDecided, false)),
        isNull(items.deletedAt),
      ),
    )
    .all();
}

/**
 * What the attachment download route reads (`apps/api/src/http/app.ts`): the
 * one attachment by its id, alongside `r2Key` (never sent to a client) and
 * server-internal enough that this has no wire schema of its own.
 *
 * Excludes an attachment of a deleted item - the same exclusion the
 * workspace read above now carries too - the download route's own test case
 * (issue 441): "an attachment id that doesn't exist, or belongs to a deleted
 * item - a 404, not a 500."
 */
export function getAttachmentForDownload(
  db: AccountDb,
  tenantId: string,
  attachmentId: string,
): AttachmentForDownload | null {
  return (
    db
      .select({
        id: attachments.id,
        itemId: attachments.itemId,
        r2Key: attachments.r2Key,
        filename: attachments.filename,
        contentType: attachments.contentType,
      })
      .from(attachments)
      .innerJoin(items, eq(attachments.itemId, items.id))
      .where(
        and(
          eq(attachments.tenantId, tenantId),
          eq(attachments.id, attachmentId),
          isNull(items.deletedAt),
        ),
      )
      .get() ?? null
  );
}

/**
 * One attachment by its id, whole - what `add_attachment` reads to tell a
 * genuine retry (the same file, replayed) from a different upload that
 * happens to reuse the id ("Attach a file to an item", issue 441).
 */
export function getAttachment(db: AccountDb, tenantId: string, attachmentId: string): AttachmentRow | null {
  return (
    db
      .select({
        id: attachments.id,
        tenantId: attachments.tenantId,
        itemId: attachments.itemId,
        r2Key: attachments.r2Key,
        filename: attachments.filename,
        size: attachments.size,
        contentType: attachments.contentType,
        createdAt: attachments.createdAt,
      })
      .from(attachments)
      .where(and(eq(attachments.tenantId, tenantId), eq(attachments.id, attachmentId)))
      .get() ?? null
  );
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

/**
 * The most `DECISION_HISTORY_LIMIT` recent settled decisions for one
 * workspace whose chosen Panel still exists, oldest first - what a routing
 * proposal reads, with no retrieval step (`docs/routing-learning.md`, "What
 * the model reads").
 *
 * Two joins to `panels`, aliased apart: the proposed Panel and the chosen one
 * are two different rows of the same table, sometimes the same row (an
 * accept) and sometimes not (an override). The proposed side still resolves
 * even for a Panel since tombstoned - `decision_history` references `panels`
 * rather than copying its name at write time (schema.ts) - but the chosen
 * side is filtered live, both the Panel and its Dashboard: a decision against
 * a Panel that has since been deleted, directly or by its Dashboard going
 * with it (`delete_dashboard` tombstones the Dashboard alone and leaves its
 * Panels' own `deletedAt` untouched - `notFiledOnALivePanel`, `isItemFiled`
 * and `listPanelsInWorkspace` above all join `dashboards` for the same
 * reason), is excluded outright, however recent - which is what ties a
 * proposal's relevance to a project you are still working: delete its Panel,
 * or the Dashboard it sits on, and its influence on future proposals goes
 * with it ("Cap the routing prompt to the last 50 decisions on panels that
 * still exist, and drop the correction override", issue 450).
 *
 * **A dismissed Item's entry is left out**, unlike a tombstoned Panel's -
 * `items.deletedAt` is the one dismissal a person actually asked for
 * (`set_dismissed`), and its whole point is that the note stops being acted
 * on; a decision history that went on handing its captured text to every
 * future classification call would not have honoured that.
 *
 * **Capped in the query, by count** - unlike the text-learning prompt's own
 * corrections and what stood, each bounded by date instead ("Cap the
 * text-learning prompt to the last 30 days, and drop rules and pinned
 * examples as inputs", issue 451; `store.ts`'s `textLearningContext`), since
 * a Panel still existing is what routing keys staleness off and writing
 * style has no panel or project of its own to. Ordered by `decidedAt`
 * descending to take the most recent `DECISION_HISTORY_LIMIT` and then
 * reversed, so the query does the narrowing and the caller still gets oldest
 * first.
 */
const DECISION_HISTORY_LIMIT = 50;

export function decisionHistoryForWorkspace(
  db: AccountDb,
  tenantId: string,
  workspaceId: string,
): DecisionHistoryEntry[] {
  const proposedPanels = alias(panels, 'proposed_panels');
  const chosenPanels = alias(panels, 'chosen_panels');
  return db
    .select({
      capturedMessage: items.capturedMessage,
      itemTitle: items.title,
      // Ids as well as names: two Panels of one Workspace can share a
      // display name (`panels_dashboard_live_folded_name` is unique only
      // within one *dashboard*, schema.ts), so accept-vs-override has to be
      // decided by id - names are for rendering, never for comparing.
      proposedPanelId: decisionHistory.proposedPanelId,
      proposedPanelName: proposedPanels.name,
      proposedPanelReason: decisionHistory.proposedPanelReason,
      chosenPanelId: decisionHistory.chosenPanelId,
      chosenPanelName: chosenPanels.name,
      decidedAt: decisionHistory.decidedAt,
    })
    .from(decisionHistory)
    .innerJoin(items, eq(decisionHistory.itemId, items.id))
    .innerJoin(chosenPanels, eq(decisionHistory.chosenPanelId, chosenPanels.id))
    .innerJoin(dashboards, eq(chosenPanels.dashboardId, dashboards.id))
    .leftJoin(proposedPanels, eq(decisionHistory.proposedPanelId, proposedPanels.id))
    .where(
      and(
        eq(decisionHistory.tenantId, tenantId),
        eq(decisionHistory.workspaceId, workspaceId),
        isNull(items.deletedAt),
        isNull(chosenPanels.deletedAt),
        isNull(dashboards.deletedAt),
      ),
    )
    // `id` breaks a tie in `decidedAt` deterministically rather than leaving
    // which side of the cap a tied row lands on to the query planner. Not a
    // finer-grained clock - `id` is the writing command's own uuidv7
    // (`decisionHistoryEntryFor`, `domain/decision-history.ts`, `ids.ts`),
    // whose bytes past the millisecond timestamp are random - so a tie is
    // resolved consistently for a given stored dataset, not by which of the
    // two was truly written first.
    .orderBy(desc(decisionHistory.decidedAt), desc(decisionHistory.id))
    .limit(DECISION_HISTORY_LIMIT)
    .all()
    .reverse();
}

/**
 * The most `RECENTLY_CAPTURED_LIMIT` recently captured notes in one
 * workspace that are filed nowhere yet, most recent first - a signal
 * separate from settled history, read for the same call ("What has been
 * captured lately and not yet filed is an input too", issue 299): what
 * somebody is writing about, before any of it is filed.
 *
 * `excludeItemId` leaves out the note this call is itself proposing for - it
 * is not "another" note yet. Bounded rather than open-ended, so the call this
 * feeds stays the same size whatever the Inbox holds (architecture, "No
 * statement's parameter count grows with the data" - the same principle,
 * even though this is a plain SELECT and not an IN list).
 */
const RECENTLY_CAPTURED_LIMIT = 20;

export function recentlyCapturedUnfiled(
  db: AccountDb,
  tenantId: string,
  workspaceId: string,
  excludeItemId: string,
): string[] {
  return db
    .select({ capturedMessage: items.capturedMessage })
    .from(items)
    .where(
      and(
        eq(items.tenantId, tenantId),
        // The same Items this Workspace's Inbox itself draws (`listOpenItems`
        // above): its own, plus every Item still undecided between
        // Workspaces, which is shown in every Inbox at once ("Capture
        // something before you know which workspace it belongs to", issue
        // 165). The `or` stays inside the `and` for the same reason
        // `listOpenItems`'s own comment gives - hoisted out, it would surface
        // every tenant's undecided Items regardless of this Workspace.
        or(eq(items.workspaceId, workspaceId), eq(items.workspaceDecided, false)),
        ne(items.id, excludeItemId),
        isNull(items.completedAt),
        isNull(items.deletedAt),
        isNotNull(items.capturedMessage),
        notFiledOnALivePanel(db, tenantId),
      ),
    )
    .orderBy(desc(items.createdAt))
    .limit(RECENTLY_CAPTURED_LIMIT)
    .all()
    .map((row) => row.capturedMessage!);
}

/**
 * Queues one rewrite attempt, "Pending" until `recordRewriteOutcome` below
 * settles it ("See the history of what Cockpit proposed for the Inbox's
 * items", issue 444).
 */
export function queueRewriteAttempt(db: AccountDb, attempt: QueuedRewriteAttempt): void {
  db.insert(rewriteHistory)
    .values({
      id: attempt.id,
      tenantId: attempt.tenantId,
      workspaceId: attempt.workspaceId,
      itemId: attempt.itemId,
      titleBefore: attempt.titleBefore,
      descriptionBefore: attempt.descriptionBefore,
      status: 'pending',
      attemptedAt: attempt.attemptedAt,
    })
    .run();
}

/**
 * Settles one queued attempt by its own id - a queue retry of the same
 * attempt calls this again with the same id, updating this one row rather
 * than adding another (issue 444).
 *
 * A no-op where the id names no row: the attempt went unrecorded (the
 * account left the register between queuing and this settling, an
 * administrative rarity `cleanUpACapturedNote` already declines rather than
 * retries for), and there is nothing here to update onto.
 */
export function recordRewriteOutcome(
  db: AccountDb,
  tenantId: string,
  attemptId: string,
  outcome: RewriteOutcome,
): void {
  // Every field set whole, never conditionally: a retry that lands on a row
  // an earlier delivery already wrote `titleAfter`/etc onto (a success,
  // later redelivered and this time failing) must leave the row's own
  // status as the only thing describing it - a `failed` row still showing a
  // stale `titleAfter` from a previous delivery would read as a rewrite
  // that both happened and didn't (found in review).
  db.update(rewriteHistory)
    .set({
      status: outcome.status,
      message: outcome.message,
      titleAfter: outcome.titleAfter ?? null,
      descriptionAfter: outcome.descriptionAfter ?? null,
      proposedPanelId: outcome.proposedPanelId ?? null,
      proposedPanelReason: outcome.proposedPanelReason ?? null,
    })
    .where(and(eq(rewriteHistory.tenantId, tenantId), eq(rewriteHistory.id, attemptId)))
    .run();
}

/** The columns a rewrite-history row is read by, joined to the Panel it proposed, if any and if it still exists. */
const rewriteHistoryColumns = {
  id: rewriteHistory.id,
  itemId: rewriteHistory.itemId,
  titleBefore: rewriteHistory.titleBefore,
  titleAfter: rewriteHistory.titleAfter,
  descriptionBefore: rewriteHistory.descriptionBefore,
  descriptionAfter: rewriteHistory.descriptionAfter,
  proposedPanelName: panels.name,
  status: rewriteHistory.status,
  message: rewriteHistory.message,
  attemptedAt: rewriteHistory.attemptedAt,
};

function asRewriteHistoryEntry(row: {
  id: string;
  itemId: string;
  titleBefore: string;
  titleAfter: string | null;
  descriptionBefore: string | null;
  descriptionAfter: string | null;
  proposedPanelName: string | null;
  status: string;
  message: string | null;
  attemptedAt: string;
}): RewriteHistoryEntryRow {
  return { ...row, status: row.status as RewriteAttemptStatus };
}

/**
 * Every rewrite attempt for one Workspace's items, most recent first, capped
 * at `REWRITE_HISTORY_LIMIT` - the table opened from the Inbox's own menu
 * (issue 444). The same Workspace privacy boundary the Inbox itself already
 * enforces: an item still undecided between Workspaces is included, the same
 * way `recentlyCapturedUnfiled` above includes it.
 *
 * **Matched on the item's current `items.workspace_id`, not the attempt's own
 * frozen one.** An item moved to another Workspace since an attempt was
 * queued is visible where it lives now and nowhere else - the same rule
 * `unfiledItemsInWorkspace` and `recentlyCapturedUnfiled` above already read
 * off `items`, not off whichever row is being joined to it.
 *
 * **A dismissed or completed item's rows are left out**, the same rule
 * `recentlyCapturedUnfiled` above states for the same reason: an item gone
 * from the Inbox has nothing here to identify it by beyond its own id, and
 * without this a dead item's rows can crowd a live one out of the capped
 * result below (found in review).
 */
export function rewriteHistoryForWorkspace(
  db: AccountDb,
  tenantId: string,
  workspaceId: string,
): RewriteHistoryEntryRow[] {
  return db
    .select(rewriteHistoryColumns)
    .from(rewriteHistory)
    .innerJoin(items, eq(rewriteHistory.itemId, items.id))
    .leftJoin(panels, and(eq(rewriteHistory.proposedPanelId, panels.id), isNull(panels.deletedAt)))
    .where(
      and(
        eq(rewriteHistory.tenantId, tenantId),
        or(eq(items.workspaceId, workspaceId), eq(items.workspaceDecided, false)),
        isNull(items.deletedAt),
        isNull(items.completedAt),
      ),
    )
    .orderBy(desc(rewriteHistory.attemptedAt))
    .limit(REWRITE_HISTORY_LIMIT)
    .all()
    .map(asRewriteHistoryEntry);
}

/**
 * Every rewrite attempt for one item, most recent first, capped at
 * `REWRITE_HISTORY_LIMIT` for the same reason the workspace-wide read above
 * is - the table opened from that item's own menu (issue 444).
 */
export function rewriteHistoryForItem(db: AccountDb, tenantId: string, itemId: string): RewriteHistoryEntryRow[] {
  return db
    .select(rewriteHistoryColumns)
    .from(rewriteHistory)
    .leftJoin(panels, and(eq(rewriteHistory.proposedPanelId, panels.id), isNull(panels.deletedAt)))
    .where(and(eq(rewriteHistory.tenantId, tenantId), eq(rewriteHistory.itemId, itemId)))
    .orderBy(desc(rewriteHistory.attemptedAt))
    .limit(REWRITE_HISTORY_LIMIT)
    .all()
    .map(asRewriteHistoryEntry);
}

/**
 * Every correction this account has ever made, oldest first - what a title or
 * description proposal reads whole, with no retrieval step ("Learn how you
 * write from the titles you correct", issue 394). Read whole here, and
 * narrowed to the last 30 days by `textLearningContext` (`store.ts`) before a
 * proposal ever sees it ("Cap the text-learning prompt to the last 30 days,
 * and drop rules and pinned examples as inputs", issue 451) - unlike
 * `decisionHistoryForWorkspace` above, which caps in the query itself by
 * count ("Cap the routing prompt to the last 50 decisions on panels that
 * still exist, and drop the correction override", issue 450). Per account
 * rather than per Workspace, deliberately unlike that function (`docs/
 * text-learning.md`, "Scope: per account").
 *
 * **Carries `itemId`, unlike the columns a prompt actually renders.** It is
 * what `textLearningContext` (`store.ts`) derives its corrected-item set from
 * instead of a second query over this same table - one read, two answers.
 */
export function textCorrectionsForAccount(db: AccountDb, tenantId: string): TextCorrectionEntry[] {
  return db
    .select({
      itemId: textCorrections.itemId,
      capturedMessage: textCorrections.capturedMessage,
      proposedTitle: textCorrections.proposedTitle,
      proposedDescription: textCorrections.proposedDescription,
      settledTitle: textCorrections.settledTitle,
      settledDescription: textCorrections.settledDescription,
      recordedAt: textCorrections.recordedAt,
    })
    .from(textCorrections)
    .where(eq(textCorrections.tenantId, tenantId))
    .orderBy(asc(textCorrections.recordedAt))
    .all();
}

/**
 * Whether a `text_corrections` row already exists for this Item - what tells
 * `command-service.ts` apart "a later edit updates the row the true first
 * edit created" from "the true first edit itself recorded nothing" (clearing
 * a title, say), the one case its own `UPDATE ... WHERE` is a documented
 * no-op for (`domain/text-corrections.ts`, `textCorrectionFor`'s own comment
 * on "The proposal is frozen at your first edit"). Read only on that branch,
 * so a correction command's answer reflects a row it actually touched rather
 * than one `textCorrectionFor` merely found a difference to describe
 * ("Re-read the rest of the inbox the moment you fix a title", issue 399).
 */
export function textCorrectionExistsFor(db: AccountDb, tenantId: string, itemId: string): boolean {
  return (
    db
      .select({ itemId: textCorrections.itemId })
      .from(textCorrections)
      .where(and(eq(textCorrections.tenantId, tenantId), eq(textCorrections.itemId, itemId)))
      .get() !== undefined
  );
}

/** The columns a pinned example is read by, named for the reason `workspaceColumns` above is: shared between the list and the single-row reads so the two can never drift on which columns they carry. */
const pinnedExampleColumns = {
  id: pinnedTextExamples.id,
  note: pinnedTextExamples.note,
  title: pinnedTextExamples.title,
  description: pinnedTextExamples.description,
  createdAt: pinnedTextExamples.createdAt,
  updatedAt: pinnedTextExamples.updatedAt,
};

/**
 * Every pinned example this account has ever added, oldest first - the same
 * "read whole, no retrieval step" convention `textCorrectionsForAccount`
 * above follows ("Pin an example of how you want a note written", issue
 * 397).
 */
export function pinnedExamplesForAccount(db: AccountDb, tenantId: string): PinnedExampleEntry[] {
  return db
    .select(pinnedExampleColumns)
    .from(pinnedTextExamples)
    .where(eq(pinnedTextExamples.tenantId, tenantId))
    .orderBy(asc(pinnedTextExamples.createdAt))
    .all();
}

/** One pinned example, or `undefined` where the id names none - what `command-service.ts` checks before an edit or a delete. */
export function getPinnedExample(
  db: AccountDb,
  tenantId: string,
  exampleId: string,
): PinnedExampleEntry | undefined {
  return db
    .select(pinnedExampleColumns)
    .from(pinnedTextExamples)
    .where(and(eq(pinnedTextExamples.tenantId, tenantId), eq(pinnedTextExamples.id, exampleId)))
    .get();
}

/**
 * Every Item this account has ever proposed texts for, with enough to tell
 * whether it has actually been acted on - what `deriveWhatStood`
 * (`domain/text-corrections.ts`) needs to tell what stood from what has not
 * been judged at all ("Learn how you write from the titles you correct",
 * issue 394).
 *
 * **Filtered to proposed Items in SQL**, unlike a plain "every open Item"
 * read: an Item nothing has ever proposed for is never judgeable, so there is
 * no reason to carry it across the Durable Object boundary only to be
 * filtered out a line later.
 *
 * **`actedOn` is filed, dismissed or completed - not `items.unseen`.** That
 * column names an unrelated, unbuilt feature (auto-routing that bypasses
 * Inbox review, `docs/functional-definition.md` §5.1) and nothing in this
 * codebase ever sets it, so it could never tell a fresh, unread proposal
 * apart from one this person has actually seen. Filed, dismissed or completed
 * are the closest things this product already records to "a person did
 * something with this row" - a dismissed Item is included here rather than
 * excluded, unlike `decisionHistoryForWorkspace`'s own exclusion of one,
 * because dismissing it is itself the act of having looked.
 */
export function judgeableItemsForAccount(db: AccountDb, tenantId: string): JudgeableItem[] {
  const filed = filedItemIds(db, tenantId);
  return db
    .select({
      id: items.id,
      title: items.title,
      textsProposedAt: items.textsProposedAt,
      textsSettledAt: items.textsSettledAt,
      completedAt: items.completedAt,
      deletedAt: items.deletedAt,
    })
    .from(items)
    .where(and(eq(items.tenantId, tenantId), isNotNull(items.textsProposedAt)))
    .all()
    .map((row) => ({
      id: row.id,
      title: row.title,
      textsProposedAt: row.textsProposedAt,
      textsSettledAt: row.textsSettledAt,
      actedOn: filed.has(row.id) || row.completedAt !== null || row.deletedAt !== null,
    }));
}

/**
 * Every Item id filed on a live Panel - the same join `isItemFiled` makes for
 * one Item at a time, made once here for the whole account instead of once
 * per row.
 */
function filedItemIds(db: AccountDb, tenantId: string): Set<string> {
  return new Set(
    db
      .selectDistinct({ itemId: panelItems.itemId })
      .from(panelItems)
      .innerJoin(panels, eq(panelItems.panelId, panels.id))
      .innerJoin(dashboards, eq(panels.dashboardId, dashboards.id))
      .where(and(eq(panelItems.tenantId, tenantId), isNull(panels.deletedAt), isNull(dashboards.deletedAt)))
      .all()
      .map((row) => row.itemId),
  );
}

/**
 * Named columns rather than the whole row, which is what keeps
 * `summary`/`summary_generated_at` unread while they are still on the table -
 * the generated half is gone and dropping its columns is a later step
 * ("Drop the nightly filing summary, keep the sentence you wrote", issue 392;
 * `docs/text-learning.md`, "Build order").
 */
const routingSummaryColumns = {
  correction: workspaceRoutingSummary.correction,
  correctionSetAt: workspaceRoutingSummary.correctionSetAt,
};

/**
 * One Workspace's own correction ("Show what the system learned, in a
 * sentence you can correct", issue 301), or null where no row exists yet -
 * a Workspace nobody has written a sentence for, which is every Workspace's
 * starting condition (`schema.ts`'s own comment on
 * `workspaceRoutingSummary`).
 *
 * **A row that holds only a summary reads back as a correction of null**, not
 * as no row at all: the generated columns are still populated on Workspaces
 * summarized before that half was removed, and this deliberately says nothing
 * about them.
 */
export function getRoutingSummary(
  db: AccountDb,
  tenantId: string,
  workspaceId: string,
): RoutingSummary | null {
  return (
    db
      .select(routingSummaryColumns)
      .from(workspaceRoutingSummary)
      .where(
        and(
          eq(workspaceRoutingSummary.tenantId, tenantId),
          eq(workspaceRoutingSummary.workspaceId, workspaceId),
        ),
      )
      .get() ?? null
  );
}

/**
 * One account's own rules for how Cockpit writes a title and a message
 * ("Show what Cockpit is told, and say how you want it changed", issue 398),
 * or null where no row exists yet - every account's starting condition, the
 * same convention `getRoutingSummary` above follows for the Workspace-scoped
 * correction it reads.
 */
export function getTextLearningRules(
  db: AccountDb,
  tenantId: string,
): { rules: string | null; rulesSetAt: string | null } | null {
  return (
    db
      .select({ rules: accountTextRules.rules, rulesSetAt: accountTextRules.rulesSetAt })
      .from(accountTextRules)
      .where(eq(accountTextRules.tenantId, tenantId))
      .get() ?? null
  );
}

/**
 * The `notExists` clause `recentlyCapturedUnfiled` above and
 * `unfiledItemsInWorkspace` below both filter on: excludes an Item genuinely
 * filed on a live Panel, the same test `isItemFiled` below makes of one Item
 * at a time and for the same reason its own comment gives - a Panel or
 * Dashboard tombstoned since the filing leaves its `panel_items` row
 * untouched, which is what puts the Item back in the Inbox, so a plain
 * `notExists(panelItems)` alone would read it as still filed forever.
 */
function notFiledOnALivePanel(db: AccountDb, tenantId: string) {
  return notExists(
    db
      .select({ one: sql`1` })
      .from(panelItems)
      .innerJoin(panels, eq(panelItems.panelId, panels.id))
      .innerJoin(dashboards, eq(panels.dashboardId, dashboards.id))
      .where(
        and(
          eq(panelItems.tenantId, tenantId),
          eq(panelItems.itemId, items.id),
          isNull(panels.deletedAt),
          isNull(dashboards.deletedAt),
        ),
      ),
  );
}

/**
 * Every item in one workspace's Inbox that has a captured note - the rest of
 * the inbox a settled filing re-proposes ("Re-propose the rest of the inbox
 * the moment you file one", issue 300). The same predicate
 * `recentlyCapturedUnfiled` above filters on, without its exclusion or its
 * limit: this call *is* the list to reclassify, not context for classifying
 * one more note.
 *
 * `workspaceId` carried per row, not assumed to be the workspace this refresh
 * was triggered from: an item still undecided between workspaces keeps
 * whatever workspace it was captured into ("Capture something before you know
 * which workspace it belongs to", issue 165) until it is filed, and that is
 * the workspace its own classification reads panels and history from -
 * exactly what `cleanUpACapturedNote` already does per note, which this
 * mirrors rather than substituting the triggering workspace for.
 */
export function unfiledItemsInWorkspace(
  db: AccountDb,
  tenantId: string,
  workspaceId: string,
): { id: string; workspaceId: string; capturedMessage: string; proposedPanelId: string | null }[] {
  return db
    .select({
      id: items.id,
      workspaceId: items.workspaceId,
      capturedMessage: items.capturedMessage,
      proposedPanelId: items.proposedPanelId,
    })
    .from(items)
    .where(
      and(
        eq(items.tenantId, tenantId),
        or(eq(items.workspaceId, workspaceId), eq(items.workspaceDecided, false)),
        isNull(items.completedAt),
        isNull(items.deletedAt),
        isNotNull(items.capturedMessage),
        notFiledOnALivePanel(db, tenantId),
      ),
    )
    .orderBy(desc(items.createdAt))
    .all()
    .map((row) => ({
      id: row.id,
      workspaceId: row.workspaceId,
      capturedMessage: row.capturedMessage!,
      proposedPanelId: row.proposedPanelId,
    }));
}

/**
 * Every item in the whole account with a captured note whose texts nobody has
 * settled - the rest of the inbox a correction re-proposes texts for
 * ("Re-read the rest of the inbox the moment you fix a title", issue 399).
 *
 * **The whole account, not one Workspace.** How this person writes is a
 * property of the account, not of the Workspace a note happens to sit in
 * (`docs/text-learning.md`, "Scope: per account") - unlike
 * `unfiledItemsInWorkspace` beside it, which is scoped because *where* a note
 * belongs is a Workspace question.
 *
 * **`texts_settled_at IS NULL` is the one filter `unfiledItemsInWorkspace`
 * does not need.** A settled Item is exactly the one this correction just
 * came from, or one a person already took over by hand - either way not a
 * candidate for a fresh proposal, and this filter is what keeps both out
 * without naming the correcting Item specially.
 *
 * **`inALiveWorkspace` is the other.** `unfiledItemsInWorkspace` is only ever
 * asked about the Workspace a filing just settled in, live by construction at
 * that moment - this query has no such caller-supplied liveness to lean on,
 * being account-wide, so it states the check itself. Without it, an Item
 * whose Workspace was later deleted would pass every other clause here and
 * become a permanent candidate: nothing can ever settle its texts (no UI
 * reaches it), so it would be re-read, and a model call spent on it, on every
 * correction anywhere in the account for as long as the account exists.
 */
export function itemsWithUnsettledTexts(
  db: AccountDb,
  tenantId: string,
): { id: string; workspaceId: string; title: string; description: string | null; capturedMessage: string }[] {
  return db
    .select({
      id: items.id,
      workspaceId: items.workspaceId,
      title: items.title,
      description: items.description,
      capturedMessage: items.capturedMessage,
    })
    .from(items)
    .where(
      and(
        eq(items.tenantId, tenantId),
        isNull(items.completedAt),
        isNull(items.deletedAt),
        isNotNull(items.capturedMessage),
        isNull(items.textsSettledAt),
        notFiledOnALivePanel(db, tenantId),
        inALiveWorkspace(db, tenantId),
      ),
    )
    .orderBy(desc(items.createdAt))
    .all()
    .map((row) => ({
      id: row.id,
      workspaceId: row.workspaceId,
      title: row.title,
      description: row.description,
      capturedMessage: row.capturedMessage!,
    }));
}

/**
 * Whether an Item's own Workspace still exists - `delete_workspace` tombstones
 * only the Workspace row and leaves every Item pointing at it exactly where it
 * was, the same fact `command-service.ts`'s own `liveDestinationPanel` states
 * for a Panel's Workspace, so nothing else in `itemsWithUnsettledTexts` above
 * excludes one on its own.
 *
 * **An undecided Item passes regardless.** `workspace_decided = false` is
 * what shows an Item in every Workspace's Inbox at once ("Capture something
 * before you know which workspace it belongs to", issue 165), so its own
 * `workspace_id` is where it happened to be captured rather than where it is
 * reachable from - the same reading `unfiledItemsInWorkspace`'s own `or(...)`
 * clause already gives it.
 */
function inALiveWorkspace(db: AccountDb, tenantId: string) {
  return or(
    eq(items.workspaceDecided, false),
    exists(
      db
        .select({ one: sql`1` })
        .from(workspaces)
        .where(
          and(eq(workspaces.tenantId, tenantId), isNull(workspaces.deletedAt), eq(workspaces.id, items.workspaceId)),
        ),
    ),
  );
}

export function commandAlreadyApplied(db: AccountDb, commandId: string): boolean {
  return db.select().from(commands).where(eq(commands.commandId, commandId)).all().length > 0;
}

/**
 * Whether an Item is filed on any Panel at all - the boundary a routing
 * proposal may not cross once true, being filed being the only way a routing
 * settles ("Propose where a captured note belongs, without filing it there",
 * issue 298), and what tells a first-ever filing apart from a reorganizing
 * one for `decision_history` ("Learn where notes belong from where you
 * actually file them", issue 299).
 *
 * **Excludes a filing whose Panel or Dashboard has since been deleted**,
 * exactly as `listFilingsInWorkspace` does and for the same reason: deleting
 * a Panel tombstones it without touching the `panel_items` rows that pointed
 * at it, which is what puts the Item back in the Inbox - so a row surviving
 * there is not evidence the Item is still filed anywhere a person can see.
 * Without this, an Item whose only Panel was deleted would read as filed
 * forever, permanently refusing it a fresh proposal and, now, permanently
 * losing the decision-history entry its next, genuinely-first-seen filing
 * ought to write.
 */
export function isItemFiled(db: AccountDb, tenantId: string, itemId: string): boolean {
  return (
    db
      .select({ panelId: panelItems.panelId })
      .from(panelItems)
      .innerJoin(panels, eq(panelItems.panelId, panels.id))
      .innerJoin(dashboards, eq(panels.dashboardId, dashboards.id))
      .where(
        and(
          eq(panelItems.tenantId, tenantId),
          eq(panelItems.itemId, itemId),
          isNull(panels.deletedAt),
          isNull(dashboards.deletedAt),
        ),
      )
      .limit(1)
      .all().length > 0
  );
}

/**
 * Every live type of the account, in the order they were put in ("Capture a
 * thought or an action, and see which it is", issue 155).
 *
 * `position` first and `createdAt` to break a tie, so the order is total even
 * where nothing has set a position - which is every account until "Manage the
 * types, and put them in the order you want" (issue 156) lands.
 */
export function listItemTypes(db: AccountDb, tenantId: string): ItemType[] {
  return db
    .select({
      id: itemTypes.id,
      tenantId: itemTypes.tenantId,
      name: itemTypes.name,
      color: itemTypes.color,
      position: itemTypes.position,
      createdAt: itemTypes.createdAt,
    })
    .from(itemTypes)
    .where(and(eq(itemTypes.tenantId, tenantId), isNull(itemTypes.deletedAt)))
    .orderBy(itemTypes.position, itemTypes.createdAt)
    .all();
}

/**
 * Every screen size of the account, narrowest first ("Give the account a list
 * of screen sizes, before anything reads it", issue 262).
 *
 * Narrowest first because that is the order they are offered in, and a size is
 * matched to a window by distance rather than by membership - so the list has
 * no order of its own to preserve and the one a person reads is the useful one.
 * `createdAt` breaks a tie, so two sizes at one width are still in a total
 * order.
 *
 * The account's, so it takes no workspace: it is read once per snapshot the way
 * `listItemTypes` is.
 */
export function listScreenSizes(db: AccountDb, tenantId: string): ScreenSize[] {
  return db
    .select({
      id: screenSizes.id,
      tenantId: screenSizes.tenantId,
      name: screenSizes.name,
      width: screenSizes.width,
      createdAt: screenSizes.createdAt,
    })
    .from(screenSizes)
    .where(eq(screenSizes.tenantId, tenantId))
    .orderBy(screenSizes.width, screenSizes.createdAt)
    .all();
}

/** One live screen size, or null - what a command naming one is checked against. */
export function getScreenSize(
  db: AccountDb,
  tenantId: string,
  screenSizeId: string,
): ScreenSize | null {
  return listScreenSizes(db, tenantId).find((size) => size.id === screenSizeId) ?? null;
}

/**
 * The highest position any of this account's types holds, or null when it has
 * none - so a new one can go after every type there is.
 *
 * **Deleted types count**, which is why this reads the table rather than the
 * live list: every read filters them out anyway, and a position that came back
 * would put a new type in front of a survivor whose own position is higher than
 * the number of types still live. The workspace list is computed the same way
 * for the same reason.
 */
export function lastItemTypePosition(db: AccountDb, tenantId: string): number | null {
  const row = db
    .select({ highest: max(itemTypes.position) })
    .from(itemTypes)
    .where(eq(itemTypes.tenantId, tenantId))
    .get();
  return row?.highest ?? null;
}

/** One live type, or null - what a capture naming a type is checked against. */
export function getItemType(db: AccountDb, tenantId: string, typeId: string): ItemType | null {
  return listItemTypes(db, tenantId).find((type) => type.id === typeId) ?? null;
}

// --- what Items mean, and which of them say the same thing (issue 407) -------

/**
 * The database, or one of its transactions - what `db.transaction` hands its
 * callback, which is not the database itself.
 *
 * Only the functions below take it. Everything above this line is either read
 * outside a transaction or written by `command-service.ts`, which has its own
 * name for the same type; these are the reads and writes a single store
 * operation does together (`rememberWhatAnItemMeans`, store.ts).
 */
type InTheStore = AccountDb | Parameters<Parameters<AccountDb['transaction']>[0]>[0];

/**
 * Whether an Item is one somebody could still act on at all ("Flag a captured
 * note that says what another one already said", issue 407).
 *
 * Three complementary conditions, and forgetting any one of them acts on
 * something that is not there any more: an Item finished with, one dismissed
 * (which is what deleting one does - functional definition, "Delete/Dismiss"),
 * and one of another account.
 *
 * **It says nothing about Workspaces**, which is what lets the two callers
 * differ: one is asking which Items are worth comparing at all, the other which
 * of the pairs that came out of that a Workspace may draw.
 */
function couldStillBeActedOn(
  // The columns rather than the table, because two of the three callers below
  // are aliases of `items` and an alias is a different type from the table it
  // aliases.
  item: Pick<
    Record<'tenantId' | 'completedAt' | 'deletedAt', Column>,
    'tenantId' | 'completedAt' | 'deletedAt'
  >,
  tenantId: string,
) {
  return and(eq(item.tenantId, tenantId), isNull(item.completedAt), isNull(item.deletedAt));
}

/**
 * The above, and one this Workspace draws - the whole of what makes a pair
 * eligible to be offered in one Workspace.
 *
 * The Workspace half is `listOpenItems`' own, repeated rather than shared
 * because this asks it of a join alias: an Item belonging to no Workspace is
 * drawn in every Workspace's Inbox, so it is eligible in all of them.
 */
function thisWorkspaceCouldActOn(
  item: Pick<
    Record<'tenantId' | 'workspaceId' | 'workspaceDecided' | 'completedAt' | 'deletedAt', Column>,
    'tenantId' | 'workspaceId' | 'workspaceDecided' | 'completedAt' | 'deletedAt'
  >,
  tenantId: string,
  workspaceId: string,
) {
  return and(
    couldStillBeActedOn(item, tenantId),
    or(eq(item.workspaceId, workspaceId), eq(item.workspaceDecided, false)),
  );
}

/**
 * A pair nobody has settled as not a duplicate ("Say a flagged pair is not a
 * duplicate", issue 408) - named for what it returns, since a `notExists`
 * reads backwards otherwise: `listDuplicatesInWorkspace` below keeps a row
 * only where this is true.
 */
function notSettledAsNotADuplicate(db: AccountDb, tenantId: string) {
  return notExists(
    db
      .select({ one: sql`1` })
      .from(duplicateSettlements)
      .where(
        and(
          eq(duplicateSettlements.tenantId, tenantId),
          eq(duplicateSettlements.itemId, itemDuplicates.itemId),
          eq(duplicateSettlements.otherItemId, itemDuplicates.otherItemId),
        ),
      ),
  );
}

/**
 * Every pair of Items in one Workspace that say the same thing - both halves of
 * which the Workspace can still draw and act on, and which nobody has settled
 * as not a duplicate.
 *
 * **Filtered here rather than when the pair is written**, which is what makes
 * dismissing an Item and bringing it back change the marks without touching a
 * row: the pair is a fact about two notes, and whether it is *offered* is a
 * question asked freshly of the state they are in - settling is the same rule
 * once more, asked of a table `replaceDuplicatesOf` never touches, which is
 * what makes a settling outlast the pair being recomputed
 * (`duplicateSettlements`, schema.ts).
 */
export function listDuplicatesInWorkspace(
  db: AccountDb,
  tenantId: string,
  workspaceId: string,
): PossibleDuplicate[] {
  const one = alias(items, 'duplicate_one');
  const other = alias(items, 'duplicate_other');
  return db
    .select({ itemId: itemDuplicates.itemId, otherItemId: itemDuplicates.otherItemId })
    .from(itemDuplicates)
    .innerJoin(one, eq(itemDuplicates.itemId, one.id))
    .innerJoin(other, eq(itemDuplicates.otherItemId, other.id))
    .where(
      and(
        eq(itemDuplicates.tenantId, tenantId),
        thisWorkspaceCouldActOn(one, tenantId, workspaceId),
        thisWorkspaceCouldActOn(other, tenantId, workspaceId),
        notSettledAsNotADuplicate(db, tenantId),
      ),
    )
    .orderBy(itemDuplicates.itemId, itemDuplicates.otherItemId)
    .all();
}

/**
 * Settles a pair as not a duplicate, or takes that back - the write behind
 * "Say a flagged pair is not a duplicate" (issue 408).
 *
 * **Idempotent on the pair, not on the command.** The same settling sent
 * twice writes the same row twice over (`onConflictDoNothing`), and an
 * unsettle naming a pair nobody had settled deletes nothing - both are the
 * ordinary case for a retried or redelivered command, not a fault.
 */
export function settleDuplicate(
  db: InTheStore,
  tenantId: string,
  pair: { itemId: string; otherItemId: string },
  settled: boolean,
  at: string,
): void {
  if (settled) {
    db.insert(duplicateSettlements)
      .values({ tenantId, ...pair, settledAt: at })
      .onConflictDoNothing()
      .run();
  } else {
    db.delete(duplicateSettlements)
      .where(
        and(
          eq(duplicateSettlements.tenantId, tenantId),
          eq(duplicateSettlements.itemId, pair.itemId),
          eq(duplicateSettlements.otherItemId, pair.otherItemId),
        ),
      )
      .run();
  }
}

/**
 * Every other Item's reading this one could be a duplicate of: read by the same
 * model.
 *
 * **Every Item of the account, whatever Workspace or state it is in - open,
 * finished with, dismissed, all of it.** A pair is a fact about two notes, and
 * whether it is *offered* is asked freshly when it is read back
 * (`listDuplicatesInWorkspace` above), so narrowing here as well would be the
 * same rule kept in two places - and the one kept here would be the lossy one:
 * `replaceDuplicatesOf` clears every pair this Item is in before writing the
 * ones it finds, so a candidate left out here takes an existing pair with it
 * and nothing recomputes it back. Finishing with an Item and dismissing one are
 * both reversible (`applySetDone`, `applySetDismissed`, domain/items.ts) and
 * neither re-reads anything on its own, so excluding either state here would
 * lose a pair the moment the *other* side of it was next edited - the same way
 * excluding another Workspace here once did.
 */
export function meaningsToCompareWith(
  db: InTheStore,
  tenantId: string,
  itemId: string,
  model: string,
): { itemId: string; reading: number[] }[] {
  return everyMeaning(db, tenantId, model).filter((other) => other.itemId !== itemId);
}

/**
 * Every reading this account holds from one model - what a whole batch of new
 * readings is compared against, read once rather than once per Item ("Give every
 * item already there a vector", issue 409).
 *
 * **One read per batch is the whole reason this exists.** The pairing is every
 * reading against every other, so asking the store for the set again per Item
 * makes a backfill over an account quadratic in its rows - which on an account
 * of a few thousand notes is megabytes of JSON parsed thousands of times, inside
 * one call.
 */
export function everyMeaning(
  db: InTheStore,
  tenantId: string,
  model: string,
): { itemId: string; reading: number[] }[] {
  return db
    .select({ itemId: itemMeanings.itemId, reading: itemMeanings.reading })
    .from(itemMeanings)
    .where(and(eq(itemMeanings.tenantId, tenantId), eq(itemMeanings.model, model)))
    .all();
}

/**
 * The open Items of this account that nothing has read yet, oldest id first,
 * from `after` onwards - what `pnpm duplicates:backfill` walks ("Give every item
 * already there a vector", issue 409).
 *
 * **"Nothing has read yet" is three states, not one**: no row at all, a row from
 * another model - which the pairing cannot compare against anything and so is no
 * reading at all (`everyMeaning` above filters on the model) - and a row emptied
 * because the Item's two texts were (`forgetMeaning` above), which is a reading
 * pointing nowhere. A note whose texts came back after being emptied is repaired
 * by the third.
 *
 * **Finished with and dismissed are left out here, unlike `everyMeaning`.** This
 * is choosing what to spend a model call on rather than what to compare, and a
 * note nothing can draw a mark on is the one case the job that reads a captured
 * note declines too (`readWhatANoteMeans`, jobs/enrichment.ts).
 *
 * **By id rather than by an offset**, because the run walks this in batches
 * across several calls while writing the rows it just read: an offset would
 * skip whatever the previous batch removed from the answer, and an Item with
 * nothing written on it stays in the answer for ever - so a walk that restarted
 * at the beginning each time would never get past the first batch of them.
 */
export function itemsToRead(
  db: AccountDb,
  tenantId: string,
  model: string,
  after: string | null,
  limit: number,
): { id: string; title: string; description: string | null }[] {
  const nothingHasReadIt = notExists(
    db
      .select({ one: sql`1` })
      .from(itemMeanings)
      .where(
        and(
          eq(itemMeanings.tenantId, tenantId),
          eq(itemMeanings.itemId, items.id),
          eq(itemMeanings.model, model),
          ne(itemMeanings.reading, []),
        ),
      ),
  );
  return db
    .select({ id: items.id, title: items.title, description: items.description })
    .from(items)
    .where(
      and(
        couldStillBeActedOn(items, tenantId),
        after === null ? undefined : gt(items.id, after),
        nothingHasReadIt,
      ),
    )
    .orderBy(asc(items.id))
    .limit(limit)
    .all();
}

/**
 * Writes what an Item means now, over whatever it meant before.
 *
 * One row per Item, replaced rather than appended to: an Item has one current
 * meaning, which is the meaning of the two texts it shows (`itemMeanings`,
 * schema.ts).
 */
export function rememberMeaning(
  db: InTheStore,
  tenantId: string,
  itemId: string,
  model: string,
  reading: number[],
  at: string,
): void {
  db.insert(itemMeanings)
    .values({ itemId, tenantId, model, reading, readAt: at })
    .onConflictDoUpdate({
      target: itemMeanings.itemId,
      set: { model, reading, readAt: at },
    })
    .run();
}

/**
 * Forgets what an Item means, and every pair that was built on it - for an
 * Item whose two texts have been emptied, which now says nothing to compare.
 *
 * **Not just "stop reading it".** Leaving the reading would leave the Item
 * flagged against notes it no longer resembles, on the strength of words nobody
 * can see any more.
 *
 * **The row stays, emptied and stamped with the time, rather than being
 * removed** - a tombstone, the same shape a dismissed Item itself has
 * (architecture, "Tombstones, not deletes"). A tab is told a Workspace has
 * changed by a row being *newer* than the copy it holds
 * (`collectInvalidations`, events.ts), and a row that has gone is newer than
 * nothing: deleting this one would drop the mark on the server and leave every
 * open tab still drawing it until something unrelated made it read again. An
 * emptied reading is also inert by construction rather than by a filter -
 * `howAlike` answers zero for one of no length (domain/duplicates.ts) - and the
 * next reading of this Item writes straight over it (`rememberMeaning` above).
 *
 * Nothing is written where the Item never had a meaning at all, which is also
 * the only case that needs no telling: a pair is only ever written between two
 * Items that both had a reading.
 */
export function forgetMeaning(db: InTheStore, tenantId: string, itemId: string, at: string): void {
  forgetDuplicatesOf(db, tenantId, itemId);
  db.update(itemMeanings)
    .set({ reading: [], readAt: at })
    .where(and(eq(itemMeanings.tenantId, tenantId), eq(itemMeanings.itemId, itemId)))
    .run();
}

/**
 * Clears every pair one Item is in.
 *
 * **Both halves, because a pair is stored one way round.** The Item is the
 * smaller id in some of its pairs and the larger in others, so a delete naming
 * only `item_id` would leave half of what it meant to clear - which is how an
 * edited note keeps a mark it no longer earns.
 */
function forgetDuplicatesOf(db: InTheStore, tenantId: string, itemId: string): void {
  db.delete(itemDuplicates)
    .where(
      and(
        eq(itemDuplicates.tenantId, tenantId),
        or(eq(itemDuplicates.itemId, itemId), eq(itemDuplicates.otherItemId, itemId)),
      ),
    )
    .run();
}

/** Replaces every pair one Item is in with the ones it is in now. */
export function replaceDuplicatesOf(
  db: InTheStore,
  tenantId: string,
  itemId: string,
  pairs: readonly { itemId: string; otherItemId: string; howAlike: number }[],
  at: string,
): void {
  forgetDuplicatesOf(db, tenantId, itemId);
  for (const pair of pairs) {
    db.insert(itemDuplicates)
      .values({ tenantId, ...pair, foundAt: at })
      // The primary key is the pair alone, so a row another account had written
      // under the same two ids would collide rather than be cleared by the
      // delete above, which is scoped to this one. Nothing about such a row is
      // this account's to overwrite, so the one already there stands - which is
      // also why nothing here can happen in the ordinary case: every pair this
      // writes names `itemId`, and every pair naming it has just gone.
      .onConflictDoNothing()
      .run();
  }
}
