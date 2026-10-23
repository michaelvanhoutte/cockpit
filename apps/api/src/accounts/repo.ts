import { alias } from 'drizzle-orm/sqlite-core';
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, max, ne, notExists, or, sql } from 'drizzle-orm';
import type { Column } from 'drizzle-orm';
import { z } from 'zod';
import {
  DEFAULT_ITEM_FORM_PRESENTATION,
  REWRITE_HISTORY_LIMIT,
  panelFilterFrom,
  panelColumnsSchema,
  panelTakesItems,
  panelSortFrom,
  themeOf,
  type AgentRun,
  type Association,
  type Attachment,
  type Dashboard,
  type Filing,
  type Item,
  type ItemFormPresentation,
  type Layout,
  type LayoutRow,
  type Panel,
  type PossibleDuplicate,
  type RecurringItem,
  type Series,
  prioritySchema,
  refinementScopeSchema,
  type RewriteAttemptStatus,
  type SuggestedPanel,
  type Source,
  type SourceAccount,
  type StoredPanelKind,
  type Workspace,
} from '@cockpit/shared';
import type { AccountDb } from './client.js';
import type { AttachmentForDownload, AttachmentRow } from '../domain/attachments.js';
import type { LayoutRowRow, PlacementRow } from '../domain/panels.js';
import type { MasterRow, SeriesRow } from '../domain/series.js';
import type { DecisionHistoryEntry } from '../domain/decision-history.js';
import { REMEMBERED_SENTENCES_KEPT, type RememberedSentenceView } from '@cockpit/shared';
import { sentencesThatFit, ITEMS_PROPOSED_AGAIN, type RememberedSentence } from '../domain/remembered-sentences.js';
import { SENDS_COMPARED, closestSends, type ClaudeSendRecord, type PastSend } from '../domain/claude-send-records.js';
import type { JudgeableItem, TextCorrectionEntry } from '../domain/text-corrections.js';
import type { QueuedRewriteAttempt, RewriteHistoryEntryRow, RewriteOutcome } from '../domain/rewrite-history.js';
import {
  accountItemFormPresentation,
  agentRunActivity,
  agentRuns,
  agents,
  associations,
  claudeSends,
  rememberedSentences,
  attachments,
  commands,
  connectionFailures,
  connectorAccounts,
  dashboards,
  decisionHistory,
  duplicateSettlements,
  itemDuplicates,
  itemMeanings,
  items,
  layoutRows,
  layouts,
  panelItems,
  panelPlacements,
  panels,
  pulledLinks,
  rewriteHistory,
  series,
  seriesPanels,
  textCorrections,
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
 * The columns a workspace is read by, named one by one: the wire shape less
 * the three colours `wireWorkspace` derives.
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
};

/**
 * A workspace as the wire carries it: the stored accent, with the band, top bar
 * and page grey filled in from the palette entry that accent names (the default
 * theme's for an accent not in the palette). Only the accent is stored; the
 * wire keeps all four so a tab on an older build still parses and paints the
 * workspace.
 */
function wireWorkspace(row: { id: string; tenantId: string; name: string; color: string }): Workspace {
  const theme = themeOf(row.color);
  return { ...row, bar: theme.bar, ground: theme.ground, header: theme.header };
}

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
    .all()
    .map(wireWorkspace);
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
  const row = db
    .select(workspaceColumns)
    .from(workspaces)
    .where(and(live(tenantId), eq(workspaces.id, workspaceId)))
    .get();
  return row ? wireWorkspace(row) : null;
}

/**
 * Writes a new workspace, naming only the columns it stores.
 *
 * **Raw SQL rather than `insert(workspaces).values(...)`, because drizzle puts
 * every column with a default into the statement**, which would name any such
 * column a later release drops. A conflict on the id is a replayed create and
 * writes nothing; a conflict on the name raises, as the index is for.
 */
export function insertWorkspace(
  db: Pick<AccountDb, 'run'>,
  row: {
    id: string;
    tenantId: string;
    name: string;
    foldedName: string;
    color: string;
    position: number;
    createdAt: string;
    deletedAt: string | null;
  },
): void {
  db.run(
    sql`INSERT INTO workspaces (id, tenant_id, name, folded_name, color, position, created_at, deleted_at)
        VALUES (${row.id}, ${row.tenantId}, ${row.name}, ${row.foldedName}, ${row.color}, ${row.position}, ${row.createdAt}, ${row.deletedAt})
        ON CONFLICT (id) DO NOTHING`,
  );
}

/**
 * The columns a dashboard is read by, named one by one for the reason the
 * workspace ones are: a bare `select()` names every column of the table, which
 * makes dropping one a two-release job. `folded_name` is deliberately not among
 * them - nothing outside the index reads it.
 *
 * **`position` is not among them either, and is not droppable for it.** It is
 * read by `listDashboards`'s ORDER BY below, so the two-release rule applies to
 * it in full, for the reason and by the measurement written out on
 * `listWorkspaces` above.
 */
const dashboardColumns = {
  id: dashboards.id,
  tenantId: dashboards.tenantId,
  workspaceId: dashboards.workspaceId,
  name: dashboards.name,
};

/**
 * A workspace's dashboards in the order they sit in the bar ("Reorder a
 * workspace's dashboards by dragging their tabs", issue 503). Tombstoned ones
 * are left out the way tombstoned workspaces are.
 *
 * `createdAt` breaks the tie, which is what a workspace nobody has ever
 * reordered leans on entirely - see `position` in schema.ts for why every row
 * of one holds the same number.
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
    .orderBy(dashboards.position, dashboards.createdAt)
    .all();
}

/**
 * The highest place any of this workspace's dashboards holds, deleted ones
 * included, or null where it has none - what a dashboard added now goes after.
 *
 * The highest rather than how many are live, the same distinction
 * `lastWorkspacePosition` carries: deleting the dashboards at 0 and 1 leaves one
 * survivor at 2, and counting the live ones would put the next one in front of
 * it rather than at the end of the bar it was meant to join.
 */
export function lastDashboardPosition(
  db: AccountDb,
  tenantId: string,
  workspaceId: string,
): number | null {
  const row = db
    .select({ highest: max(dashboards.position) })
    .from(dashboards)
    .where(and(eq(dashboards.tenantId, tenantId), eq(dashboards.workspaceId, workspaceId)))
    .get();
  return row?.highest ?? null;
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
  // Whether proposals leave a Panel of items out.
  neverPropose: panels.neverPropose,
  // What a Filter gathers, which is also what says the panel is one.
  filterConditions: panels.filterConditions,
  // How a panel of items is sorted, or null for Manual.
  sortCriteria: panels.sortCriteria,
  // The narrowest a column may be, or null for one list.
  columns: panels.columns,
};

/**
 * One stored panel as everything outside this file reads it: the wire's kind is
 * `filter` wherever the conditions column is set, and what it holds and how it
 * is sorted are the parsed shapes rather than the text of two columns.
 *
 * **The one place that translation happens** ("Add a Filter panel that shows
 * every filed item due in a window", issue 463), so nothing above this has to
 * remember that the stored kind and the read kind are not the same question.
 */
function panelAsRead(row: PanelRowRead): Panel {
  const { filterConditions, sortCriteria, columns: storedColumns, ...rest } = row;
  const filter = panelFilterFrom(filterConditions);
  const sort = panelSortFrom(sortCriteria);
  // A name this release cannot read is one list, as a sort it cannot read is Manual.
  const columns = panelColumnsSchema.safeParse(storedColumns).data ?? null;
  return filter === null
    ? { ...rest, filter: null, sort, columns }
    : { ...rest, kind: 'filter', filter, sort, columns };
}

/** What `panelColumns` selects, before `panelAsRead` turns it into a `Panel`. */
type PanelRowRead = Omit<Panel, 'kind' | 'filter' | 'sort' | 'columns'> & {
  kind: StoredPanelKind;
  filterConditions: string | null;
  sortCriteria: string | null;
  columns: string | null;
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
    .all()
    .map(panelAsRead);
}

/** One live panel, wherever it sits. Its `dashboardId` is what the changes to it scope by. */
export function getPanel(db: AccountDb, tenantId: string, panelId: string): Panel | null {
  const row =
    db
      .select(panelColumns)
      .from(panels)
      .where(and(eq(panels.tenantId, tenantId), eq(panels.id, panelId), isNull(panels.deletedAt)))
      .get() ?? null;
  return row === null ? null : panelAsRead(row);
}

/**
 * The workspace a live panel is in, or null for a panel that is deleted, one
 * whose dashboard is deleted, and one this account never held - the three a
 * read of one Panel cannot tell apart and must not ("Read a Panel from an app
 * allowed only to read", issue 1445). The workspace's own tombstone is the
 * caller's to check, as `snapshot`'s is.
 */
export function workspaceOfPanel(db: AccountDb, tenantId: string, panelId: string): string | null {
  const row = db
    .select({ workspaceId: dashboards.workspaceId })
    .from(panels)
    .innerJoin(dashboards, eq(panels.dashboardId, dashboards.id))
    .where(
      and(
        eq(panels.tenantId, tenantId),
        eq(panels.id, panelId),
        isNull(panels.deletedAt),
        isNull(dashboards.deletedAt),
      ),
    )
    .get();
  return row?.workspaceId ?? null;
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
    .all()
    .map(panelAsRead);
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

/** A dashboard's one layout, or null where nobody has arranged it yet. */
export function layoutOfDashboard(
  db: AccountDb,
  tenantId: string,
  dashboardId: string,
): { id: string } | null {
  return (
    db
      .select({ id: layouts.id })
      .from(layouts)
      .where(and(eq(layouts.tenantId, tenantId), eq(layouts.dashboardId, dashboardId)))
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
      title: layoutRows.title,
    })
    .from(layoutRows)
    .where(and(eq(layoutRows.tenantId, tenantId), eq(layoutRows.layoutId, layoutId)))
    .orderBy(asc(layoutRows.rowIndex))
    .all();
}

/** One layout's rows as the snapshot draws them, which is what a save from a tab that predates Sections is placed against. */
export function storedRowsOf(db: AccountDb, tenantId: string, layoutId: string): LayoutRow[] {
  return rowsOf(listLayoutRows(db, tenantId, layoutId), listPlacements(db, tenantId, layoutId));
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
 * At most one per dashboard, so the order is only there to be stable: oldest
 * first, the id breaking a tie.
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
    .orderBy(layouts.createdAt, layouts.id)
    .all();
  if (found.length === 0) return [];

  // Reached by the same join as the layouts above rather than by naming the
  // ids just found. Naming them bound one variable per layout, which SQLite
  // refuses past a limit - and it refused the *whole* workspace read, so a
  // workspace stopped painting entirely once it had accumulated enough layouts,
  // which is one per dashboard and nothing unusual. The join binds the
  // workspace and nothing that grows.
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
      title: layoutRows.title,
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
 * **The rows are what the arrangement is**, so a row with no cells and no title
 * is dropped rather than drawn: a save writes both lists in one transaction and
 * never leaves an empty one behind, but a row whose only panel was deleted is
 * exactly that state, and a blank line on the dashboard is not what a deleted
 * panel should look like. **A titled row is a Section** and is kept with no
 * cells, which is all it ever holds; a row of Panels carries no title at all,
 * so it reads exactly as it did before Sections.
 *
 * Both lists arrive ordered, so this only groups.
 */
function rowsOf(
  heights: readonly { rowIndex: number; height: number | null; title: string | null }[],
  cells: readonly { panelId: string; rowIndex: number; span: number }[],
): LayoutRow[] {
  return heights
    .map((row): LayoutRow => ({
      height: row.height,
      ...(row.title === null ? {} : { title: row.title }),
      cells: cells
        .filter((cell) => cell.rowIndex === row.rowIndex)
        .map(({ panelId, span }) => ({ panelId, span })),
    }))
    .filter((row) => row.cells.length > 0 || row.title !== undefined);
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
  /**
   * Where the Item came from, which is two columns and one answer ("Save a
   * Teams message to Cockpit", issue 486): `source_connector` wherever a
   * connector or front door is named, and `source` everywhere else. Coalesced
   * here, so nothing above this file has to know that a CHECK on a table with
   * four children is why there are two (`STORED_SOURCES`, schema.ts).
   */
  source: sql<Source>`coalesce(${items.sourceConnector}, ${items.source})`.as('source'),
  sourceId: items.sourceId,
  sourceLink: items.sourceLink,
  sender: items.sender,
  sourceTimestamp: items.sourceTimestamp,
  capturedMessage: items.capturedMessage,
  capturedTimeZone: items.capturedTimeZone,
  title: items.title,
  description: items.description,
  textsSettledAt: items.textsSettledAt,
  textsProposedAt: items.textsProposedAt,
  readings: items.readings,
  proposedPanelId: items.proposedPanelId,
  proposedPanelReason: items.proposedPanelReason,
  proposedPanelFit: items.proposedPanelFit,
  claudeProposals: items.claudeProposals,
  sourceResolvedAt: items.sourceResolvedAt,
  nextAction: items.nextAction,
  completedAt: items.completedAt,
  startedAt: items.startedAt,
  priority: items.priority,
  prioritySetAt: items.prioritySetAt,
  dueDate: items.dueDate,
  dueDateSetAt: items.dueDateSetAt,
  dueDateChosenAt: items.dueDateChosenAt,
  seriesId: items.seriesId,
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

/** One series as its row holds it, with what each copy is made from, or null where the account has none by that id. */
export function getSeries(db: AccountDb, tenantId: string, seriesId: string): MasterRow | null {
  return (
    db
      .select({
        ...seriesRowColumns(),
        workspaceId: series.workspaceId,
        title: series.title,
        description: series.description,
        priority: series.priority,
      })
      .from(series)
      .where(and(eq(series.tenantId, tenantId), eq(series.id, seriesId)))
      .get() ?? null
  );
}

/**
 * The Panels a series files each copy on, top first, live or not - the caller
 * asks which still are ("Make each copy of a recurring item from its own
 * series", issue 1448).
 */
export function masterPanelIdsOf(db: AccountDb, tenantId: string, seriesId: string): string[] {
  return db
    .select({ panelId: seriesPanels.panelId })
    .from(seriesPanels)
    .where(and(eq(seriesPanels.tenantId, tenantId), eq(seriesPanels.seriesId, seriesId)))
    .orderBy(asc(seriesPanels.position), asc(seriesPanels.panelId))
    .all()
    .map((row) => row.panelId);
}

/**
 * The recurring items of one Workspace - the series that run and hold what each
 * copy is made from - soonest *Next on* first ("Make, change and delete
 * recurring items from the Recurring items modal", issue 1449). **Every one,
 * with no page**: a person's handful. Each carries the Panels it files on that
 * are still live in the Workspace and take Items, top first, since a Panel
 * deleted since is skipped when a copy is made and so is not offered again.
 * Read in three statements however many there are: a list of ids to look the
 * Panels up by would meet the store's limit on bound values.
 */
export function listRecurringItems(db: AccountDb, tenantId: string, workspaceId: string): RecurringItem[] {
  const running = and(
    eq(series.tenantId, tenantId),
    eq(series.workspaceId, workspaceId),
    isNull(series.stoppedAt),
    isNotNull(series.title),
  );
  const rows = db
    .select({ ...seriesColumns, workspaceId: series.workspaceId, title: series.title, description: series.description, priority: series.priority })
    .from(series)
    .where(running)
    .orderBy(series.nextOn, series.title, series.id)
    .all();
  const live = new Set(listPanelsInWorkspace(db, tenantId, workspaceId).filter(panelTakesItems).map((panel) => panel.id));
  const filedOn = new Map<string, string[]>();
  const filings = db
    .select({ seriesId: seriesPanels.seriesId, panelId: seriesPanels.panelId })
    .from(seriesPanels)
    .innerJoin(series, eq(series.id, seriesPanels.seriesId))
    .where(and(running, eq(seriesPanels.tenantId, tenantId)))
    .orderBy(asc(seriesPanels.position), asc(seriesPanels.panelId))
    .all();
  for (const { seriesId, panelId } of filings) {
    if (live.has(panelId)) filedOn.set(seriesId, [...(filedOn.get(seriesId) ?? []), panelId]);
  }
  return rows.map((row) => ({
    id: row.id,
    workspaceId,
    title: row.title ?? '',
    description: row.description ?? '',
    priority: row.priority,
    frequency: row.frequency,
    nextOn: row.nextOn,
    dueAfterDays: row.dueAfterDays,
    panelIds: filedOn.get(row.id) ?? [],
  }));
}

function seriesRowColumns() {
  return {
    ...seriesColumns,
    anchorOn: series.anchorOn,
    lastOn: series.lastOn,
    createdAt: series.createdAt,
    updatedAt: series.updatedAt,
  };
}

/**
 * Every series not yet stopped by deleting its recurring item ("Bring a repeating Item back on its day",
 * issue 1407) - what the account's alarm is set by and brings back. A handful
 * per account, so the day each is due on is worked out by the caller rather than
 * stored beside it.
 */
export function listRunningSeries(db: AccountDb, tenantId: string): SeriesRow[] {
  return db
    .select(seriesRowColumns())
    .from(series)
    .where(and(eq(series.tenantId, tenantId), isNull(series.stoppedAt)))
    .orderBy(series.createdAt, series.id)
    .all();
}

/**
 * The latest Item of a series, dismissed or not - what says whether the
 * previous one is still open when the next is due ("Make each copy of a
 * recurring item from its own series", issue 1448). Latest by when it was
 * made, which each occurrence is after the one before it (`occurrenceOf`).
 * Null where no Item names it yet.
 */
export function latestOccurrence(db: AccountDb, tenantId: string, seriesId: string): Item | null {
  return (
    db
      .select(itemColumns)
      .from(items)
      .where(and(eq(items.tenantId, tenantId), eq(items.seriesId, seriesId)))
      .orderBy(desc(items.createdAt), desc(items.id))
      .limit(1)
      .get() ?? null
  );
}

const seriesColumns = {
  id: series.id,
  tenantId: series.tenantId,
  frequency: series.frequency,
  nextOn: series.nextOn,
  dueAfterDays: series.dueAfterDays,
  timeZone: series.timeZone,
  stoppedAt: series.stoppedAt,
};

/**
 * Every series the Items of one Workspace name ("Repeat an Item on a schedule",
 * issue 1405), stopped ones included: an Item still names the series
 * deleting its recurring item stopped. **The same Items `listOpenItems` returns**, which is why this carries
 * the same `or`: an Item belonging to no Workspace is drawn in every one.
 */
export function listSeriesInWorkspace(db: AccountDb, tenantId: string, workspaceId: string): Series[] {
  return db
    // With the recurring item's own title and Workspace, which a copy's line and mark say ("Point a copy at its master, and retire the Repeats chip", issue 1450); null on a series never made into one.
    .selectDistinct({ ...seriesColumns, title: series.title, workspaceId: series.workspaceId })
    .from(series)
    .innerJoin(items, eq(items.seriesId, series.id))
    .where(
      and(
        eq(series.tenantId, tenantId),
        eq(items.tenantId, tenantId),
        or(eq(items.workspaceId, workspaceId), eq(items.workspaceDecided, false)),
        isNull(items.deletedAt),
      ),
    )
    .orderBy(series.createdAt)
    .all();
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
 * Every file on one Item, oldest first - what an agent's message links
 * ("Send an item's attachments along when an agent starts", issue 573).
 */
export function listAttachmentsOfItem(
  db: AccountDb,
  tenantId: string,
  itemId: string,
): { id: string; filename: string; contentType: string }[] {
  return db
    .select({ id: attachments.id, filename: attachments.filename, contentType: attachments.contentType })
    .from(attachments)
    .where(and(eq(attachments.tenantId, tenantId), eq(attachments.itemId, itemId)))
    .orderBy(asc(attachments.createdAt), asc(attachments.id))
    .all();
}

/** An attachment's row whole, as `AttachmentRow` holds it. */
const attachmentRowColumns = {
  id: attachments.id,
  tenantId: attachments.tenantId,
  itemId: attachments.itemId,
  r2Key: attachments.r2Key,
  filename: attachments.filename,
  size: attachments.size,
  contentType: attachments.contentType,
  createdAt: attachments.createdAt,
};

/**
 * One attachment by its id, whole - what `add_attachment` reads to tell a
 * genuine retry (the same file, replayed) from a different upload that
 * happens to reuse the id ("Attach a file to an item", issue 441).
 */
export function getAttachment(db: AccountDb, tenantId: string, attachmentId: string): AttachmentRow | null {
  return (
    db
      .select(attachmentRowColumns)
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
 * **A decision filed onto a Panel flagged Never propose is left out** too,
 * read at proposal time rather than marked when filed, so clearing the flag
 * puts its past filings back ("Keep a Panel out of proposals with Never
 * propose", issue 848). Each decision names one chosen Panel, so an Item also
 * filed onto an ordinary Panel keeps that decision.
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
        // Filings onto a Panel flagged Never propose are not learned from,
        // read now so clearing the flag puts them back (issue 848).
        eq(chosenPanels.neverPropose, false),
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

/** How many of an account's latest time zones a capture without a readable one of its own may fall back through. */
const RECENT_TIME_ZONES_LIMIT = 5;

/**
 * The distinct time zones this account's captures carried, the most recently
 * captured in first, and none where none did ("Read a due date you say when
 * you capture, on your own calendar", issue 1077) - the calendars a capture
 * without a readable zone of its own is read on, the first the runtime can
 * read winning, so a zone only the browser knows never hides one before it.
 * Most recent by the instant it was captured, dismissed Items included, since
 * where somebody is is not a property of what they kept.
 */
export function recentCapturedTimeZones(db: AccountDb, tenantId: string): string[] {
  const latest = max(items.createdAt);
  return db
    .select({ timeZone: items.capturedTimeZone })
    .from(items)
    .where(and(eq(items.tenantId, tenantId), isNotNull(items.capturedTimeZone)))
    .groupBy(items.capturedTimeZone)
    .orderBy(desc(latest))
    .limit(RECENT_TIME_ZONES_LIMIT)
    .all()
    .flatMap((row) => (row.timeZone === null ? [] : [row.timeZone]));
}

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
      looksAt: attempt.looksAt,
      panelBeforeId: attempt.panelBeforeId,
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
      // A delivery that changed nothing leaves a row that kept a priority or
      // a due date (below) a change still, or the field would stay set and
      // vanish from what Cockpit changed.
      status:
        outcome.status === 'left-as-is'
          ? sql`CASE WHEN ${rewriteHistory.prioritySet} IS NOT NULL OR ${rewriteHistory.dueDateSet} IS NOT NULL OR ${rewriteHistory.workspaceSet} IS NOT NULL OR ${rewriteHistory.panelsFiledOn} IS NOT NULL THEN 'rewritten' ELSE 'left-as-is' END`
          : outcome.status,
      message: outcome.message,
      titleAfter: outcome.titleAfter ?? null,
      descriptionAfter: outcome.descriptionAfter ?? null,
      proposedPanelId: outcome.proposedPanelId ?? null,
      proposedPanelReason: outcome.proposedPanelReason ?? null,
      // **The one field kept rather than set whole.** A priority an earlier
      // delivery set stays on the item, and a later delivery finds the field
      // holding a value and sets nothing - so the row keeps saying what this
      // attempt set, whatever a redelivery did ("Read a priority you say when
      // you capture", issue 1076).
      prioritySet: sql`coalesce(${outcome.prioritySet ?? null}, ${rewriteHistory.prioritySet})`,
      // Kept the same way, for the same reason ("Read a due date you say when
      // you capture, on your own calendar", issue 1077).
      dueDateSet: sql`coalesce(${outcome.dueDateSet ?? null}, ${rewriteHistory.dueDateSet})`,
      // And the Workspace it settled the item in ("Settle an Any workspace
      // capture in the workspace you name", issue 1078).
      workspaceSet: sql`coalesce(${outcome.workspaceSet ?? null}, ${rewriteHistory.workspaceSet})`,
      // And the Panels it filed the note on, by name ("List the panels a
      // capture was filed on in What Cockpit changed", issue 1117).
      panelsFiledOn: sql`coalesce(${outcome.panelsFiledOn?.length ? JSON.stringify(outcome.panelsFiledOn) : null}, ${rewriteHistory.panelsFiledOn})`,
    })
    .where(and(eq(rewriteHistory.tenantId, tenantId), eq(rewriteHistory.id, attemptId)))
    .run();
}

/**
 * The suggested Panel a row started from and the one it settled on, each
 * joined whether or not it has since been deleted - a deleted one is named as
 * such rather than read as none ("Rename Rewrite history to Smart
 * refinements, and show each field's change", issue 614).
 */
const panelBefore = alias(panels, 'panel_before');
const panelAfter = alias(panels, 'panel_after');
const dashboardBefore = alias(dashboards, 'dashboard_before');
const dashboardAfter = alias(dashboards, 'dashboard_after');

/** The columns a rewrite-history row is read by. */
const rewriteHistoryColumns = {
  id: rewriteHistory.id,
  itemId: rewriteHistory.itemId,
  titleBefore: rewriteHistory.titleBefore,
  titleAfter: rewriteHistory.titleAfter,
  descriptionBefore: rewriteHistory.descriptionBefore,
  descriptionAfter: rewriteHistory.descriptionAfter,
  status: rewriteHistory.status,
  message: rewriteHistory.message,
  attemptedAt: rewriteHistory.attemptedAt,
  looksAt: rewriteHistory.looksAt,
  prioritySet: rewriteHistory.prioritySet,
  dueDateSet: rewriteHistory.dueDateSet,
  workspaceSet: rewriteHistory.workspaceSet,
  panelsFiledOn: rewriteHistory.panelsFiledOn,
  beforeId: panelBefore.id,
  beforeName: panelBefore.name,
  beforeDeletedAt: panelBefore.deletedAt,
  afterId: panelAfter.id,
  afterName: panelAfter.name,
  afterDeletedAt: panelAfter.deletedAt,
  beforeDashboardName: dashboardBefore.name,
  beforeDashboardDeletedAt: dashboardBefore.deletedAt,
  afterDashboardName: dashboardAfter.name,
  afterDashboardDeletedAt: dashboardAfter.deletedAt,
};

/** Named only while both the Panel and its Dashboard are live; otherwise it reads as a deleted Panel. */
function suggestedPanel(
  id: string | null,
  name: string | null,
  deletedAt: string | null,
  dashboardName: string | null,
  dashboardDeletedAt: string | null,
): SuggestedPanel | null {
  if (id === null) return null;
  const live = deletedAt === null && dashboardDeletedAt === null && dashboardName !== null;
  return { id, name: live ? name : null, dashboardName: live ? dashboardName : null };
}

/** The names a `panels_filed_on` column holds; none where it is empty or is not a JSON list of names. */
function namesIn(held: string | null): string[] {
  if (held === null) return [];
  try {
    return z.string().array().safeParse(JSON.parse(held)).data ?? [];
  } catch {
    return [];
  }
}

function asRewriteHistoryEntry(row: {
  id: string;
  itemId: string;
  titleBefore: string;
  titleAfter: string | null;
  descriptionBefore: string | null;
  descriptionAfter: string | null;
  status: string;
  message: string | null;
  attemptedAt: string;
  looksAt: string | null;
  prioritySet: string | null;
  dueDateSet: string | null;
  workspaceSet: string | null;
  panelsFiledOn: string | null;
  beforeId: string | null;
  beforeName: string | null;
  beforeDeletedAt: string | null;
  afterId: string | null;
  afterName: string | null;
  afterDeletedAt: string | null;
  beforeDashboardName: string | null;
  beforeDashboardDeletedAt: string | null;
  afterDashboardName: string | null;
  afterDashboardDeletedAt: string | null;
}): RewriteHistoryEntryRow {
  const after = suggestedPanel(
    row.afterId,
    row.afterName,
    row.afterDeletedAt,
    row.afterDashboardName,
    row.afterDashboardDeletedAt,
  );
  return {
    id: row.id,
    itemId: row.itemId,
    titleBefore: row.titleBefore,
    titleAfter: row.titleAfter,
    descriptionBefore: row.descriptionBefore,
    descriptionAfter: row.descriptionAfter,
    proposedPanelName: after?.name ?? null,
    status: row.status as RewriteAttemptStatus,
    message: row.message,
    attemptedAt: row.attemptedAt,
    // A value outside the set (no CHECK holds it to one) reads as never recorded.
    looksAt: refinementScopeSchema.safeParse(row.looksAt).data ?? null,
    suggestedPanelBefore: suggestedPanel(
      row.beforeId,
      row.beforeName,
      row.beforeDeletedAt,
      row.beforeDashboardName,
      row.beforeDashboardDeletedAt,
    ),
    suggestedPanelAfter: after,
    // A value outside the set reads as none, as `looksAt` above does.
    prioritySet: prioritySchema.safeParse(row.prioritySet).data ?? null,
    dueDateSet: z.iso.date().safeParse(row.dueDateSet).data ?? null,
    workspaceSet: row.workspaceSet,
    // Anything that is not a list of names reads as none, as `looksAt` above does.
    panelsFiledOn: namesIn(row.panelsFiledOn),
  };
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
    .leftJoin(panelBefore, eq(rewriteHistory.panelBeforeId, panelBefore.id))
    .leftJoin(panelAfter, eq(rewriteHistory.proposedPanelId, panelAfter.id))
    .leftJoin(dashboardBefore, eq(panelBefore.dashboardId, dashboardBefore.id))
    .leftJoin(dashboardAfter, eq(panelAfter.dashboardId, dashboardAfter.id))
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
    .leftJoin(panelBefore, eq(rewriteHistory.panelBeforeId, panelBefore.id))
    .leftJoin(panelAfter, eq(rewriteHistory.proposedPanelId, panelAfter.id))
    .leftJoin(dashboardBefore, eq(panelBefore.dashboardId, dashboardBefore.id))
    .leftJoin(dashboardAfter, eq(panelAfter.dashboardId, dashboardAfter.id))
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
 * How this account has the Item's form drawn ("Let the item's form dock to
 * the side of the screen instead of opening as a dialog", issue 481),
 * resolved to `DEFAULT_ITEM_FORM_PRESENTATION` for an account that has never
 * written one - every account's starting condition.
 */
export function getItemFormPresentation(db: AccountDb, tenantId: string): ItemFormPresentation {
  const row = db
    .select({ presentation: accountItemFormPresentation.presentation })
    .from(accountItemFormPresentation)
    .where(eq(accountItemFormPresentation.tenantId, tenantId))
    .get();
  return row?.presentation ?? DEFAULT_ITEM_FORM_PRESENTATION;
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
): UnfiledCandidate[] {
  return db
    .select({
      id: items.id,
      workspaceId: items.workspaceId,
      capturedMessage: items.capturedMessage,
      title: items.title,
      description: items.description,
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
      title: row.title,
      description: row.description,
      proposedPanelId: row.proposedPanelId,
    }));
}

/**
 * One Item a settled filing's refresh reads again: the note and the two texts
 * it carries now are what the panel choice is read from (`choose-a-panel.v3`).
 */
export interface UnfiledCandidate {
  id: string;
  workspaceId: string;
  capturedMessage: string;
  title: string;
  description: string | null;
  proposedPanelId: string | null;
}

/**
 * The notes filed in one Workspace since `since`, each with the meaning stored
 * for it from `model`, `null` where nothing has read it yet - what a filing's
 * refresh of the rest of the Inbox weighs the unfiled Items against
 * (`itemsToReadAgain`, `domain/panel-refresh.ts`; "Cut what cleaning up a
 * captured note costs", issue 887).
 *
 * **A filing is a `decision_history` row**, the record of a settled routing
 * and the same one that fires the refresh. A reading emptied because its
 * Item's texts were reads as none (`forgetMeaning`).
 */
export function filingMeaningsSince(
  db: AccountDb,
  tenantId: string,
  workspaceId: string,
  since: string,
  model: string,
): (number[] | null)[] {
  return db
    .select({ reading: itemMeanings.reading })
    .from(decisionHistory)
    .leftJoin(
      itemMeanings,
      and(
        eq(itemMeanings.itemId, decisionHistory.itemId),
        eq(itemMeanings.tenantId, tenantId),
        eq(itemMeanings.model, model),
      ),
    )
    .where(
      and(
        eq(decisionHistory.tenantId, tenantId),
        eq(decisionHistory.workspaceId, workspaceId),
        gt(decisionHistory.decidedAt, since),
      ),
    )
    .all()
    .map((row) => (row.reading === null || row.reading.length === 0 ? null : row.reading));
}

/** How many ids one query names: a Durable Object's SQLite takes 100 bound values, and the tenant and model are two of them. */
const IDS_PER_QUERY = 50;

/**
 * The meaning stored from `model` for each of these Items, `null` for one
 * nothing has read - in the order given.
 */
export function meaningsOfItems(
  db: AccountDb,
  tenantId: string,
  itemIds: readonly string[],
  model: string,
): { itemId: string; reading: number[] | null }[] {
  const held = new Map<string, number[]>();
  for (let from = 0; from < itemIds.length; from += IDS_PER_QUERY) {
    const group = itemIds.slice(from, from + IDS_PER_QUERY);
    for (const row of db
      .select({ itemId: itemMeanings.itemId, reading: itemMeanings.reading })
      .from(itemMeanings)
      .where(and(eq(itemMeanings.tenantId, tenantId), eq(itemMeanings.model, model), inArray(itemMeanings.itemId, group)))
      .all()) {
      held.set(row.itemId, row.reading);
    }
  }
  return itemIds.map((itemId) => {
    const reading = held.get(itemId);
    return { itemId, reading: reading === undefined || reading.length === 0 ? null : reading };
  });
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

/** What a proposal for Claude reads beside the Item itself (issue 1161). */
export interface ClaudeProposalContext {
  /** The Workspace's name, or null for an Item belonging to none yet. */
  workspace: string | null;
  /** The live Panels it is filed on, each with its Dashboard. */
  filedOn: { dashboard: string; panel: string }[];
  /** The folders sent to Claude in from its Workspace (from any, for an Item in none yet), most recently used first. */
  folders: string[];
  /**
   * The sends closest to this Item (issue 1162), closest first; none where
   * nothing has read it yet, where nothing has been sent, or where nothing
   * sent is like it.
   */
  pastSends: PastSend[];
  /** The remembered sentences that fit it (issue 1163), the most used first; none where nothing was remembered. */
  remembered: RememberedSentence[];
}

/** The most folders a proposal is offered, most recently used first. */
const FOLDERS_OFFERED = 12;

/**
 * Where an Item stands, for proposing what to do with it ("Propose what to do
 * with each item before you look", issue 1161): its Workspace's name, the
 * Panels it is filed on - leaving out a deleted Panel or Dashboard, as
 * `isItemFiled` does - and the folders its Workspace has opened Claude in, which
 * are the only folders a proposal may name - and the closest past sends, read
 * from the meanings `model` made of the Items they were for (issue 1162).
 */
export function claudeProposalContext(
  db: AccountDb,
  tenantId: string,
  itemId: string,
  model: string,
): ClaudeProposalContext {
  const item = db
    .select({ workspaceId: items.workspaceId, workspaceDecided: items.workspaceDecided, source: effectiveSource })
    .from(items)
    .where(and(eq(items.tenantId, tenantId), eq(items.id, itemId)))
    .get();
  const workspace =
    item && item.workspaceDecided
      ? (db
          .select({ name: workspaces.name })
          .from(workspaces)
          .where(and(eq(workspaces.tenantId, tenantId), eq(workspaces.id, item.workspaceId)))
          .get()?.name ?? null)
      : null;
  const filedOn = db
    .select({ dashboard: dashboards.name, panel: panels.name })
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
    .orderBy(asc(dashboards.name), asc(panels.name))
    .all();
  const folders = db
    .select({ folder: agentRuns.folder, last: max(agentRuns.startedAt) })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.tenantId, tenantId),
        isNotNull(agentRuns.destination),
        ne(agentRuns.folder, ''),
        // Its own Workspace's folders only, so an item one Workspace receives
        // never has another's repository offered for it; every folder for an
        // item that belongs to none yet.
        item?.workspaceDecided ? eq(agentRuns.workspaceId, item.workspaceId) : undefined,
      ),
    )
    .groupBy(agentRuns.folder)
    .orderBy(desc(max(agentRuns.startedAt)))
    .limit(FOLDERS_OFFERED)
    .all()
    .flatMap((row) => (row.folder ? [row.folder] : []));
  return {
    workspace,
    filedOn,
    folders,
    pastSends: closestPastSends(db, tenantId, itemId, model, item?.workspaceDecided ? item.workspaceId : null),
    remembered: item
      ? sentencesThatFit(
          { sourceKind: item.source, workspaceId: item.workspaceDecided ? item.workspaceId : null },
          rememberedForSource(db, tenantId, item.source),
        )
      : [],
  };
}

/**
 * Where an Item came from as the row names it: the connector that brought it
 * where there is one, and otherwise the kind of source (`Item.source`). What a
 * remembered sentence is matched on (issue 1163).
 */
const effectiveSource = sql<string>`coalesce(${items.sourceConnector}, ${items.source})`;

/** Every sentence this account remembered for one kind of source. */
function rememberedForSource(db: AccountDb, tenantId: string, sourceKind: string): RememberedSentence[] {
  return db
    .select()
    .from(rememberedSentences)
    .where(and(eq(rememberedSentences.tenantId, tenantId), eq(rememberedSentences.sourceKind, sourceKind)))
    .all();
}

/**
 * Keeps a sentence, once: the same id again is left as it is, and a new one
 * past `REMEMBERED_SENTENCES_KEPT` is not kept (issue 1163).
 */
export function rememberSentence(
  db: InTheStore,
  tenantId: string,
  one: { id: string; workspaceId: string | null; sourceKind: string; action: string; sentence: string; createdAt: string },
): 'kept' | 'full' {
  const held = db.select({ id: rememberedSentences.id }).from(rememberedSentences).where(eq(rememberedSentences.tenantId, tenantId)).all();
  if (held.some((row) => row.id === one.id)) return 'kept';
  if (held.length >= REMEMBERED_SENTENCES_KEPT) return 'full';
  db.insert(rememberedSentences).values({ ...one, tenantId }).onConflictDoNothing().run();
  return 'kept';
}

/** The account's remembered sentences, the newest first, with the name of the Workspace each names (issue 1164). */
export function listRememberedSentences(db: AccountDb, tenantId: string): RememberedSentenceView[] {
  const names = new Map(listWorkspaces(db, tenantId).map((one) => [one.id, one.name]));
  return db
    .select()
    .from(rememberedSentences)
    .where(eq(rememberedSentences.tenantId, tenantId))
    .orderBy(desc(rememberedSentences.createdAt), desc(rememberedSentences.id))
    .all()
    .map((row) => ({
      id: row.id,
      sentence: row.sentence,
      action: row.action,
      sourceKind: row.sourceKind,
      workspaceId: row.workspaceId,
      workspaceName: row.workspaceId === null ? null : (names.get(row.workspaceId) ?? null),
      useCount: row.useCount,
      lastUsedAt: row.lastUsedAt,
      createdAt: row.createdAt,
    }));
}

/** Rewords a sentence; false where the account has none by that id. */
export function editRememberedSentence(db: InTheStore, tenantId: string, id: string, sentence: string): boolean {
  const changed = db
    .update(rememberedSentences)
    .set({ sentence })
    .where(and(eq(rememberedSentences.tenantId, tenantId), eq(rememberedSentences.id, id)))
    .returning({ id: rememberedSentences.id })
    .all();
  return changed.length > 0;
}

/** Forgets a sentence; nothing happens where the account has none by that id. */
export function deleteRememberedSentence(db: InTheStore, tenantId: string, id: string): void {
  db.delete(rememberedSentences).where(and(eq(rememberedSentences.tenantId, tenantId), eq(rememberedSentences.id, id))).run();
}

/** Counts a use of each of these sentences: a proposal was written with them (issue 1163). */
export function countSentencesUsed(db: InTheStore, tenantId: string, ids: readonly string[], at: string): void {
  if (ids.length === 0) return;
  db.update(rememberedSentences)
    .set({ useCount: sql`${rememberedSentences.useCount} + 1`, lastUsedAt: at })
    .where(and(eq(rememberedSentences.tenantId, tenantId), inArray(rememberedSentences.id, [...ids])))
    .run();
}

/**
 * The open Items a sentence may fit, newest first and at most
 * `ITEMS_PROPOSED_AGAIN`: those from the same kind of source, in its Workspace
 * where it names one (an Item belonging to none yet is in no Workspace, so a
 * sentence naming one never fits it), and not finished with or dismissed.
 */
export function openItemsASentenceMayFit(
  db: AccountDb,
  tenantId: string,
  sourceKind: string,
  workspaceId: string | null,
): string[] {
  return db
    .select({ id: items.id })
    .from(items)
    .where(
      and(
        eq(items.tenantId, tenantId),
        sql`${effectiveSource} = ${sourceKind}`,
        isNull(items.completedAt),
        isNull(items.deletedAt),
        workspaceId === null ? undefined : and(eq(items.workspaceDecided, true), eq(items.workspaceId, workspaceId)),
      ),
    )
    .orderBy(desc(items.updatedAt), desc(items.id))
    .limit(ITEMS_PROPOSED_AGAIN)
    .all()
    .map((row) => row.id);
}

/** What the offer to remember is made from: one kept send, where it came from, and the Workspaces' names. */
export interface SendToOfferOn {
  send: ClaudeSendRecord;
  sourceKind: string;
  workspaceDecided: boolean;
  workspaces: { id: string; name: string }[];
}

/** The send kept under a Run, with what the offer needs beside it; null where none was kept. */
export function sendToOfferOn(db: AccountDb, tenantId: string, runId: string): SendToOfferOn | null {
  const row = db
    .select()
    .from(claudeSends)
    .where(and(eq(claudeSends.tenantId, tenantId), eq(claudeSends.id, runId)))
    .get();
  if (!row) return null;
  const item = db
    .select({ source: effectiveSource, workspaceDecided: items.workspaceDecided })
    .from(items)
    .where(and(eq(items.tenantId, tenantId), eq(items.id, row.itemId)))
    .get();
  if (!item) return null;
  return {
    send: {
      id: row.id,
      workspaceId: row.workspaceId,
      itemId: row.itemId,
      itemTitle: row.itemTitle,
      itemDescription: row.itemDescription,
      proposed: { destination: row.proposedDestination, folder: row.proposedFolder, prompt: row.proposedPrompt },
      sent: { destination: row.sentDestination, folder: row.sentFolder, prompt: row.sentPrompt },
      sentAt: row.sentAt,
    },
    sourceKind: item.source,
    workspaceDecided: item.workspaceDecided,
    workspaces: listWorkspaces(db, tenantId).map((one) => ({ id: one.id, name: one.name })),
  };
}

/**
 * Keeps what was sent to Claude, once: a send already kept under the same Run
 * is left as it is, so the same Open twice is one record (issue 1162).
 */
export function recordClaudeSend(db: InTheStore, tenantId: string, send: ClaudeSendRecord): void {
  db.insert(claudeSends)
    .values({
      id: send.id,
      tenantId,
      workspaceId: send.workspaceId,
      itemId: send.itemId,
      itemTitle: send.itemTitle,
      itemDescription: send.itemDescription,
      proposedDestination: send.proposed.destination,
      proposedFolder: send.proposed.folder,
      proposedPrompt: send.proposed.prompt,
      sentDestination: send.sent.destination,
      sentFolder: send.sent.folder,
      sentPrompt: send.sent.prompt,
      sentAt: send.sentAt,
    })
    .onConflictDoNothing()
    .run();
}

/**
 * The past sends closest to one Item, found with the meanings already kept for
 * duplicates (`item_meanings`, issue 1162): the account's newest
 * `SENDS_COMPARED` sends, each compared with the Item by the meaning `model`
 * read from the Item it was for.
 *
 * **Only this account's own** (every read is scoped to `tenantId`), **and for
 * an Item in a Workspace, only that Workspace's** - the rule the folders
 * offered keep, so a send made for one Workspace never carries its folder, or
 * the way its mail was written, into another's. An Item belonging to none yet
 * sees every Workspace's. **Never the Item's own sends**: it is being
 * proposed for again, not asked what it was sent as.
 *
 * Nothing at all where the Item has no meaning yet (it was only just captured,
 * and the reading is a job of its own) or an emptied one.
 */
function closestPastSends(
  db: AccountDb,
  tenantId: string,
  itemId: string,
  model: string,
  inWorkspace: string | null,
): PastSend[] {
  const reading = db
    .select({ reading: itemMeanings.reading })
    .from(itemMeanings)
    .where(and(eq(itemMeanings.tenantId, tenantId), eq(itemMeanings.itemId, itemId), eq(itemMeanings.model, model)))
    .get()?.reading;
  if (!reading || reading.length === 0) return [];

  // Placed by the readings alone first: a send keeps its prompts up to 100,000
  // characters apiece, and only the few that are shown need to be read.
  const placed = db
    .select({ id: claudeSends.id, itemId: claudeSends.itemId, reading: itemMeanings.reading })
    .from(claudeSends)
    .innerJoin(
      itemMeanings,
      and(eq(itemMeanings.itemId, claudeSends.itemId), eq(itemMeanings.tenantId, claudeSends.tenantId), eq(itemMeanings.model, model)),
    )
    .where(
      and(
        eq(claudeSends.tenantId, tenantId),
        ne(claudeSends.itemId, itemId),
        inWorkspace === null ? undefined : eq(claudeSends.workspaceId, inWorkspace),
      ),
    )
    .orderBy(desc(claudeSends.sentAt), desc(claudeSends.id))
    .limit(SENDS_COMPARED)
    .all();

  const closest = closestSends(reading, placed);
  if (closest.length === 0) return [];

  const kept = new Map(
    db
      .select()
      .from(claudeSends)
      .where(and(eq(claudeSends.tenantId, tenantId), inArray(claudeSends.id, closest.map((one) => one.id))))
      .all()
      .map((row) => [row.id, row]),
  );
  return closest.flatMap((one) => {
    const row = kept.get(one.id);
    if (!row) return [];
    return [
      {
        title: row.itemTitle,
        description: row.itemDescription,
        proposed: { destination: row.proposedDestination, folder: row.proposedFolder, prompt: row.proposedPrompt },
        sent: { destination: row.sentDestination, folder: row.sentFolder, prompt: row.sentPrompt },
      },
    ];
  });
}

// --- Runs: an Item sent to Claude, or one an Agent started -------------------

const runColumns = {
  id: agentRuns.id,
  itemId: agentRuns.itemId,
  agentId: agentRuns.agentId,
  agentName: agents.name,
  agentDeletedAt: agents.deletedAt,
  status: agentRuns.status,
  sessionUrl: agentRuns.sessionUrl,
  reason: agentRuns.reason,
  startedAt: agentRuns.startedAt,
  waiting: agentRunActivity.waiting,
  destination: agentRuns.destination,
  folder: agentRuns.folder,
  stage: agentRuns.stage,
  resultUrl: agentRuns.resultUrl,
  note: agentRuns.note,
};

/**
 * A run as the row draws it: the Agent named as it is now, and one deleted
 * since by nobody's name (issue 571, "the chip names a deleted agent").
 */
function runFrom(row: {
  id: string;
  itemId: string;
  agentId: string;
  agentName: string | null;
  agentDeletedAt: string | null;
  status: AgentRun['status'];
  sessionUrl: string | null;
  reason: string | null;
  startedAt: string;
  waiting: boolean | null;
  destination: AgentRun['destination'];
  folder: string | null;
  stage: string | null;
  resultUrl: string | null;
  note: string | null;
}): AgentRun {
  const { agentDeletedAt, agentName, ...run } = row;
  return {
    ...run,
    waiting: row.waiting ?? false,
    agentName: agentDeletedAt ? null : agentName,
  };
}

/**
 * Every open run on one Workspace's open Items, oldest first (issue 571).
 *
 * **Joined against Items still to be done.** Done and Dismiss end the run
 * themselves; this keeps a run an Item's Done or Dismiss never ended
 * from counting on the dock for good.
 */
export function listOpenAgentRuns(db: AccountDb, tenantId: string, workspaceId: string): AgentRun[] {
  return db
    .select(runColumns)
    .from(agentRuns)
    .innerJoin(
      items,
      and(eq(items.id, agentRuns.itemId), isNull(items.completedAt), isNull(items.deletedAt)),
    )
    .leftJoin(agents, eq(agents.id, agentRuns.agentId))
    .leftJoin(agentRunActivity, eq(agentRunActivity.runId, agentRuns.id))
    .where(
      and(
        eq(agentRuns.tenantId, tenantId),
        // Or an Item sent to Claude that is drawn here: one sent from an Inbox
        // before it belongs to a Workspace is in every Inbox, and one filed
        // since belongs to where it was filed (issue 1159). An Agent's run is
        // listed only where it was started, as it always was.
        or(
          eq(agentRuns.workspaceId, workspaceId),
          and(
            isNotNull(agentRuns.destination),
            or(eq(items.workspaceId, workspaceId), eq(items.workspaceDecided, false)),
          ),
        ),
        isNull(agentRuns.endedAt),
      ),
    )
    .orderBy(asc(agentRuns.startedAt), asc(agentRuns.id))
    .all()
    .map(runFrom);
}

/** One Item's open run, or undefined - what a second start on it is checked against. */
export function openAgentRunOn(db: AccountDb, tenantId: string, itemId: string): AgentRun | undefined {
  const row = db
    .select(runColumns)
    .from(agentRuns)
    .leftJoin(agents, eq(agents.id, agentRuns.agentId))
    .leftJoin(agentRunActivity, eq(agentRunActivity.runId, agentRuns.id))
    .where(and(eq(agentRuns.tenantId, tenantId), eq(agentRuns.itemId, itemId), isNull(agentRuns.endedAt)))
    .get();
  return row ? runFrom(row) : undefined;
}

/** Whether any run other than this one started on the Item at or after `since` - what stops an undo reopening an older run beside a newer one. */
export function anotherRunStartedSince(
  db: AccountDb,
  tenantId: string,
  itemId: string,
  runId: string,
  since: string,
): boolean {
  return (
    db
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.tenantId, tenantId),
          eq(agentRuns.itemId, itemId),
          ne(agentRuns.id, runId),
          gte(agentRuns.startedAt, since),
        ),
      )
      .get() !== undefined
  );
}

/** One run, open or ended, with the Workspace it belongs to - or undefined. */
export function getAgentRun(
  db: AccountDb,
  tenantId: string,
  runId: string,
): (AgentRun & { workspaceId: string; endedAt: string | null }) | undefined {
  const row = db
    .select({ ...runColumns, workspaceId: agentRuns.workspaceId, endedAt: agentRuns.endedAt })
    .from(agentRuns)
    .leftJoin(agents, eq(agents.id, agentRuns.agentId))
    .leftJoin(agentRunActivity, eq(agentRunActivity.runId, agentRuns.id))
    .where(and(eq(agentRuns.tenantId, tenantId), eq(agentRuns.id, runId)))
    .get();
  if (!row) return undefined;
  const { workspaceId, endedAt, ...rest } = row;
  return { ...runFrom(rest), workspaceId, endedAt };
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

/**
 * The source accounts one Workspace has connected, oldest first ("Connect a
 * Microsoft Teams source account", issue 485).
 *
 * **The two sealed columns are not selected**, which is the whole shape of
 * this read: what the window shows is who is connected, and the credential is
 * opened only by the connector that is about to use it. A read that carried
 * it would put it in a snapshot, in a cache and on a wire, all for nothing.
 */
export function sourceAccountsIn(
  db: AccountDb,
  tenantId: string,
  workspaceId: string,
): SourceAccount[] {
  return db
    .select({
      id: connectorAccounts.id,
      connectorId: connectorAccounts.connectorId,
      displayName: connectorAccounts.displayName,
      connectedAt: connectorAccounts.connectedAt,
      lastTestedAt: connectorAccounts.lastTestedAt,
      failingBecause: connectionFailures.reason,
      choice: connectorAccounts.choice,
      filesByName: connectorAccounts.filesByName,
      dueInDays: connectorAccounts.dueInDays,
    })
    .from(connectorAccounts)
    .leftJoin(connectionFailures, eq(connectionFailures.sourceAccountId, connectorAccounts.id))
    .where(
      and(
        eq(connectorAccounts.tenantId, tenantId),
        eq(connectorAccounts.workspaceId, workspaceId),
      ),
    )
    // The id breaks the tie, because `connected_at` does not: two tabs
    // connecting two accounts at once share a millisecond, and a list whose
    // order moves between reads is one whose rows jump under the pointer.
    .orderBy(asc(connectorAccounts.connectedAt), asc(connectorAccounts.id))
    .all()
    // What it follows is the choice its connection stored, as the value alone:
    // the label is the connector's own and is put beside it where the registry
    // is known (issue 942).
    .map(({ choice, ...account }) => (choice === null ? account : { ...account, follows: choice }));
}

/**
 * The connection one Workspace holds to this account at this source, by the
 * key the source names it with - what a push is matched against ("Save a Teams
 * message to Cockpit", issue 486).
 *
 * **Identifiers only, and the credential columns deliberately not among
 * them.** Whether a push belongs to anybody is answered before anything sealed
 * is so much as read, which is what `sealedCredentialOf` below is for and why
 * it is a second read rather than two columns on this one.
 */
export function connectionUnder(
  db: AccountDb,
  tenantId: string,
  workspaceId: string,
  connectorId: string,
  externalAccountKey: string,
): { id: string } | undefined {
  return db
    .select({ id: connectorAccounts.id })
    .from(connectorAccounts)
    .where(
      and(
        eq(connectorAccounts.tenantId, tenantId),
        eq(connectorAccounts.workspaceId, workspaceId),
        eq(connectorAccounts.connectorId, connectorId),
        eq(connectorAccounts.externalAccountKey, externalAccountKey),
      ),
    )
    .get();
}

/**
 * The sealed credential of one connection, for the connector that is about to
 * use it (issue 486). The only read in the application that names those two
 * columns, and the only path to them is a push already matched to this row by
 * `connectionUnder` above.
 */
export function sealedCredentialOf(
  db: AccountDb,
  tenantId: string,
  sourceAccountId: string,
): { sealedCredential: string; credentialNonce: string; externalAccountKey: string | null } | undefined {
  return db
    .select({
      sealedCredential: connectorAccounts.encryptedCredential,
      credentialNonce: connectorAccounts.credentialNonce,
      externalAccountKey: connectorAccounts.externalAccountKey,
    })
    .from(connectorAccounts)
    .where(
      and(eq(connectorAccounts.tenantId, tenantId), eq(connectorAccounts.id, sourceAccountId)),
    )
    .get();
}

/**
 * One connected source account by its id, or `undefined` - what
 * `command-service.ts` checks before disconnecting, so a disconnect naming a
 * row that is no longer there is a 404 rather than a delete that quietly
 * matches nothing.
 */
export function getSourceAccount(
  db: AccountDb,
  tenantId: string,
  sourceAccountId: string,
):
  | {
      id: string;
      workspaceId: string;
      connectorId: string;
      externalAccountKey: string | null;
      choice: string | null;
      filesByName: boolean;
      dueInDays: number | null;
    }
  | undefined {
  return db
    .select({
      id: connectorAccounts.id,
      workspaceId: connectorAccounts.workspaceId,
      connectorId: connectorAccounts.connectorId,
      externalAccountKey: connectorAccounts.externalAccountKey,
      choice: connectorAccounts.choice,
      filesByName: connectorAccounts.filesByName,
      dueInDays: connectorAccounts.dueInDays,
    })
    .from(connectorAccounts)
    .where(
      and(eq(connectorAccounts.tenantId, tenantId), eq(connectorAccounts.id, sourceAccountId)),
    )
    .get();
}

/**
 * The due date a pulled connection gave this Item, or null where it gave none
 * or the Item was not brought in by one - what makes the Item's date "still the
 * connection's" while it equals it (issue 1409).
 */
export function givenDueDateOf(db: AccountDb, tenantId: string, itemId: string): string | null {
  return (
    db
      .select({ givenDueDate: pulledLinks.givenDueDate })
      .from(pulledLinks)
      .where(and(eq(pulledLinks.tenantId, tenantId), eq(pulledLinks.itemId, itemId)))
      .get()?.givenDueDate ?? null
  );
}
