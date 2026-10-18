import { itemLabel, type Item } from './item.js';
import { panelGathers } from './panel.js';
import type { WorkspaceSnapshot } from '../api/snapshot.js';
import { itemIdsWithRun } from './dashboard-filter.js';
import { filingsThatFile, itemsInTheInbox, stillOpen } from './filing.js';
import { panelAndFilterIdsByItem } from './filters.js';
import type { Day } from './filters.js';

/**
 * Find item, the column's second mode ("Find an open Item with F and Shift+F,
 * and land on its row", issue 828): the open Items of this Dashboard or this
 * Workspace that match what is typed, each with where it is.
 *
 * **Matching is in the browser over the snapshot the read model already
 * holds**, and **each Item's search text is derived once per snapshot**, not per
 * keystroke: `useFindIndex` builds the index when the snapshot is replaced - a
 * revalidation, an edit made elsewhere - and holds it only in memory, never
 * with the snapshot. A keystroke then only scans the lowercased text.
 */

/** At most this many rows are drawn, the rest being counted. */
export const FIND_LIMIT = 50;

/** Where an Item is: a Panel it is filed on, or a Filter panel that gathers it, with the Dashboard it is on. */
export type FoundPlace = { dashboardId: string; dashboardName: string; panelId: string; panelName: string };

/** One open Item with its search text and where it is, most recently changed first in the index. */
export type FindEntry = {
  item: Item;
  /** Title, description, next action and sender, lowercased, one line apart. */
  text: string;
  /** The Panels it is filed on, on the Dashboards in tab order; none for an Item in the Inbox. */
  places: readonly FoundPlace[];
  /**
   * The Filter panels that gather it, on the Dashboards in tab order and each
   * Dashboard's Panels in their order. Only *Dashboard* scope reads these:
   * *Workspace* names where an Item is filed.
   */
  gatheredOn: readonly FoundPlace[];
  /** Whether the Item is finished, which only *Include done* lists. */
  done: boolean;
};

export type FindIndex = readonly FindEntry[];

/** Where Find searches: this Dashboard or this Workspace. */
export type FindScope = 1 | 2;

/** One row of the result. */
export type FoundItem = {
  itemId: string;
  /** What the row is called: the Item's label, its next action or its title. */
  title: string;
  /** Where the Item is, as the row says it: its Panel, "Dashboard ▸ Panel" (+n for more), or *Inbox*. */
  where: string;
  /** The Panel the screen goes to, or null for the Inbox and for a finished Item. */
  panel: FoundPlace | null;
  /** Whether the Item is finished: on no Dashboard, so it is gone to in *All items*. */
  done: boolean;
};

/** The text a search runs over: what a person would type to find the Item. */
export function searchTextOf(item: Pick<Item, 'title' | 'description' | 'nextAction' | 'sender'>): string {
  return [item.title, item.description ?? '', item.nextAction ?? '', item.sender ?? ''].join('\n').toLowerCase();
}

/**
 * Every Item of the Workspace with its search text and places, the open ones
 * first and then the finished, each most recently changed first. **An Item filed on a Filter panel only is in the
 * Inbox**, as the Inbox itself and *All items* read it (`filingsThatFile`).
 * **What a Filter panel gathers is read the way the board draws it**
 * (`panelAndFilterIdsByItem`, ignoring the Dashboard's own filter, which landing
 * clears), so the index follows `today` and the open runs as well as the snapshot.
 */
export function indexForFind(snapshot: WorkspaceSnapshot, today: Day): FindIndex {
  const panels = snapshot.panels;
  const filings = filingsThatFile(snapshot.filings, panels);
  const dashboardOrder = new Map(snapshot.dashboards.map((dashboard, at) => [dashboard.id, at]));
  const dashboardNames = new Map(snapshot.dashboards.map((dashboard) => [dashboard.id, dashboard.name]));
  const panelsById = new Map(panels.map((panel) => [panel.id, panel]));
  // The Panels each Item is filed on, then the Filter panels gathering it, as the rows' "also in" reads them.
  const heldBy = panelAndFilterIdsByItem(
    snapshot.items,
    snapshot.filings,
    panels,
    snapshot.dashboards,
    itemIdsWithRun(snapshot.agentRuns),
    today,
  );
  const placesOf = new Map<string, FoundPlace[]>();
  const gatheredOf = new Map<string, FoundPlace[]>();
  for (const [itemId, panelIds] of heldBy) {
    for (const panelId of panelIds) {
      const panel = panelsById.get(panelId);
      const dashboardName = panel && dashboardNames.get(panel.dashboardId);
      if (!panel || dashboardName === undefined) continue;
      const into = panelGathers(panel) ? gatheredOf : placesOf;
      const list = into.get(itemId) ?? [];
      list.push({ dashboardId: panel.dashboardId, dashboardName, panelId: panel.id, panelName: panel.name });
      into.set(itemId, list);
    }
  }
  const inbox = new Set(itemsInTheInbox(snapshot.items, filings).map((item) => item.id));
  const entries: FindEntry[] = [];
  for (const item of snapshot.items) {
    // A finished Item is on no Dashboard: it has no place, and is listed only by Include done.
    if (!stillOpen(item)) {
      entries.push({ item, text: searchTextOf(item), places: [], gatheredOn: [], done: true });
      continue;
    }
    const byDashboard = (a: FoundPlace, b: FoundPlace) =>
      (dashboardOrder.get(a.dashboardId) ?? 0) - (dashboardOrder.get(b.dashboardId) ?? 0);
    const places = (placesOf.get(item.id) ?? []).toSorted(byDashboard);
    const gatheredOn = (gatheredOf.get(item.id) ?? []).toSorted(byDashboard);
    // Filed, but on nothing the snapshot names: on no screen at all, so not offered.
    if (places.length === 0 && gatheredOn.length === 0 && !inbox.has(item.id)) continue;
    entries.push({ item, text: searchTextOf(item), places, gatheredOn, done: false });
  }
  return entries.toSorted((a, b) => Number(a.done) - Number(b.done) || b.item.updatedAt.localeCompare(a.item.updatedAt));
}

/**
 * The open Items matching what is typed, in scope, and how many more there are
 * past the limit. Nothing typed matches nothing. *Dashboard* keeps the Items
 * drawn on `dashboardId` - filed on a Panel of it or gathered by a Filter panel
 * of it; *Workspace* keeps every one, the Inbox's included. An Item in several
 * places is one row, going to the first - in *Dashboard* the Panels it is filed
 * on here, then the Filter panels here; in *Workspace* only where it is filed,
 * the Dashboard on screen's own first, then the others in tab order.
 * `withDone` (*Workspace* only) adds the finished Items matching, after the open ones.
 */
export function findItems(
  index: FindIndex,
  query: string,
  scope: FindScope,
  dashboardId: string,
  limit = FIND_LIMIT,
  withDone = false,
): { rows: FoundItem[]; more: number } {
  const needle = query.trim().toLowerCase();
  if (needle === '') return { rows: [], more: 0 };
  const rows: FoundItem[] = [];
  let matched = 0;
  for (const entry of index) {
    if (!entry.text.includes(needle)) continue;
    if (entry.done && !(withDone && scope === 2)) continue;
    const here = entry.places.filter((place) => place.dashboardId === dashboardId);
    const gatheredHere = entry.gatheredOn.filter((place) => place.dashboardId === dashboardId);
    if (scope === 1 && here.length + gatheredHere.length === 0) continue;
    matched += 1;
    if (rows.length >= limit) continue;
    const places = scope === 1 ? [...here, ...gatheredHere] : [...here, ...entry.places.filter((place) => place.dashboardId !== dashboardId)];
    const first = places[0] ?? null;
    if (entry.done) {
      rows.push({ itemId: entry.item.id, title: itemLabel(entry.item), where: 'done', panel: null, done: true });
      continue;
    }
    const more = places.length > 1 ? ` +${places.length - 1}` : '';
    const where =
      first === null ? 'Inbox' : scope === 1 ? `${first.panelName}${more}` : `${first.dashboardName} ▸ ${first.panelName}${more}`;
    rows.push({ itemId: entry.item.id, title: itemLabel(entry.item), where, panel: first, done: false });
  }
  return { rows, more: matched - rows.length };
}
