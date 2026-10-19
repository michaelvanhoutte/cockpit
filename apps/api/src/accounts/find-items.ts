import {
  NO_CONDITIONS,
  NO_DASHBOARD_FILTER,
  filingsThatFile,
  findNeedle,
  isFiltering,
  itemsMatchingFilter,
  matchesDashboardFilter,
  panelGathers,
  panelTakesItems,
  placesFiledOn,
  searchTextOf,
  textMatches,
  type Dashboard,
  type DueWindow,
  type Item,
  type ItemStatus,
  type Panel,
  type Priority,
} from '@cockpit/shared';
import type { AccountDb } from './client.js';
import {
  listAttachmentsOfItems,
  listDashboards,
  listFilingsInWorkspace,
  listFilingsOfItems,
  listItemsToFind,
  listOpenAgentRuns,
  listPanelsInWorkspace,
  listWorkspaces,
} from './repo.js';

/**
 * What `find_items` asks of an account's store and what it gets back ("Find
 * items in Cockpit from a connected app, over MCP", issue 1240): the Items in
 * scope read through the (workspace, status) index, narrowed by the same rules
 * the screen narrows by (`@cockpit/shared`), cut to one page.
 */

/** How many Items one page holds. */
export const FIND_PAGE = 25;

/** A question asked of the account's Items, every part already read and checked by the tool. */
export interface FindItemsAsk {
  /** What was typed, as Find item matches it; empty for no text. */
  text: string;
  /** One Workspace, or null for the whole account. */
  workspaceId: string | null;
  /** The Panels (and Filter panels) an Item must be on or gathered by, or null for no Panel condition. */
  panelIds: readonly string[] | null;
  statuses: readonly ItemStatus[];
  priorities: readonly Priority[];
  due: { window: DueWindow; orOverdue: boolean } | null;
  /** Whether finished Items are read at all; a dismissed Item never is. */
  includeDone: boolean;
  /** The calendar day every due condition and Filter panel counts from. */
  today: string;
  /** Where the previous page ended: the last Item's change time and id. */
  after: { changedAt: string; id: string } | null;
}

export interface FoundItem {
  item: Item;
  /** "Dashboard ▸ Panel" for each Panel the Item is filed on; none for an Item in the Inbox. */
  places: string[];
  attachments: { id: string; filename: string; contentType: string; size: number }[];
}

export interface FoundPage {
  found: FoundItem[];
  /** Whether more Items follow this page. No total is given: counting would read every row in scope. */
  more: boolean;
}

/** A Panel `find_items` may be asked about, with the Workspace it is in. */
export interface PanelToFind {
  id: string;
  name: string;
  workspaceId: string;
  dashboardName: string;
}

/** Every Panel of one Workspace, or of the whole account, by name - what a `panel` argument is read against. */
export function panelsToFind(db: AccountDb, tenantId: string, workspaceId: string | null): PanelToFind[] {
  const found: PanelToFind[] = [];
  for (const workspace of workspaceId === null ? listWorkspaces(db, tenantId) : [{ id: workspaceId }]) {
    const dashboards = listDashboards(db, tenantId, workspace.id);
    for (const panel of listPanelsInWorkspace(db, tenantId, workspace.id)) {
      const dashboard = dashboards.find((candidate) => candidate.id === panel.dashboardId);
      if (dashboard) found.push({ id: panel.id, name: panel.name, workspaceId: workspace.id, dashboardName: dashboard.name });
    }
  }
  return found;
}

const NONE: ReadonlySet<string> = new Set();

/**
 * One page of the Items an ask matches.
 *
 * **The Items are the rows in scope and everything else is checked on them**:
 * text by Find item's rule, status, priority and due by the Dashboard filter
 * bar's, a Panel by the filings and - for a Filter panel - by what it gathers.
 * The cursor is applied after, on the same order the rows were read in, so
 * any instance answers any page and nothing is held between calls.
 *
 * **Where each Item is read for the page's Items alone**, and a Workspace's
 * Panels and filings in full only when a Filter panel is named, since what it
 * gathers is a question about the whole Workspace.
 */
export function findItemsIn(db: AccountDb, tenantId: string, ask: FindItemsAsk): FoundPage {
  const rows = listItemsToFind(db, tenantId, { workspaceId: ask.workspaceId, includeDone: ask.includeDone });
  const onPanel = ask.panelIds ? itemsOnPanels(db, tenantId, ask, rows) : null;

  const needle = findNeedle(ask.text);
  const narrowing = {
    ...NO_DASHBOARD_FILTER,
    statuses: [...ask.statuses],
    priorities: [...ask.priorities],
    due: ask.due,
  };
  const narrows = isFiltering(narrowing);
  const matching = rows.filter((item) => {
    if (needle !== '' && !textMatches(searchTextOf(item), needle)) return false;
    if (onPanel && !onPanel.has(item.id)) return false;
    return !narrows || matchesDashboardFilter(narrowing, item, NONE, ask.today, NONE);
  });

  const { page, more } = pageOf(matching, ask.after);
  return { found: describeItems(db, tenantId, page), more };
}

/**
 * The page that follows a cursor out of Items already in the order they were
 * read (newest change first, the id breaking a tie): those after the cursor's
 * change time and id, cut to the page - and whether any follow it.
 *
 * **The id is what makes the edge exact**: two Items changed at the same
 * moment sit either side of the cursor by id, so each is on one page and none
 * is repeated or skipped.
 */
export function pageOf<T extends Pick<Item, 'updatedAt' | 'id'>>(
  matching: readonly T[],
  after: FindItemsAsk['after'],
  size = FIND_PAGE,
): { page: T[]; more: boolean } {
  const following = after
    ? matching.filter((item) => item.updatedAt < after.changedAt || (item.updatedAt === after.changedAt && item.id < after.id))
    : matching;
  return { page: following.slice(0, size), more: following.length > size };
}

/** The ids of the Items on any of the named Panels, or gathered by any named Filter panel. */
function itemsOnPanels(db: AccountDb, tenantId: string, ask: FindItemsAsk, rows: readonly Item[]): Set<string> {
  const wanted = new Set(ask.panelIds);
  const onPanel = new Set<string>();
  for (const workspace of ask.workspaceId === null ? listWorkspaces(db, tenantId) : [{ id: ask.workspaceId }]) {
    const panels = listPanelsInWorkspace(db, tenantId, workspace.id);
    const named = panels.filter((panel) => wanted.has(panel.id));
    if (named.length === 0) continue;
    const filings = listFilingsInWorkspace(db, tenantId, workspace.id);
    const filed = filingsThatFile(filings, panels);
    const gatherers = named.filter(panelGathers);
    for (const panel of named.filter(panelTakesItems)) {
      for (const filing of filed) if (filing.panelId === panel.id) onPanel.add(filing.itemId);
    }
    if (gatherers.length === 0) continue;
    const inWorkspace = rows.filter((item) => item.workspaceId === workspace.id);
    const dashboards = listDashboards(db, tenantId, workspace.id);
    const withRun = new Set(listOpenAgentRuns(db, tenantId, workspace.id).map((run) => run.itemId));
    for (const panel of gatherers) {
      for (const item of itemsMatchingFilter(inWorkspace, filings, panels, dashboards, panel.filter ?? NO_CONDITIONS, withRun, ask.today)) {
        onPanel.add(item.id);
      }
    }
  }
  return onPanel;
}

/** A page's Items with where each is filed and its files, read for those Items alone. */
function describeItems(db: AccountDb, tenantId: string, page: readonly Item[]): FoundItem[] {
  const ids = page.map((item) => item.id);
  const filings = listFilingsOfItems(db, tenantId, ids);
  const panels: Panel[] = [];
  const dashboards: Dashboard[] = [];
  for (const workspaceId of new Set(page.map((item) => item.workspaceId))) {
    panels.push(...listPanelsInWorkspace(db, tenantId, workspaceId));
    dashboards.push(...listDashboards(db, tenantId, workspaceId));
  }
  const files = listAttachmentsOfItems(db, tenantId, ids);
  return page.map((item) => ({
    item,
    places: placesFiledOn(item, filings, panels, dashboards),
    attachments: files
      .filter((file) => file.itemId === item.id)
      .map(({ id, filename, contentType, size }) => ({ id, filename, contentType, size })),
  }));
}
