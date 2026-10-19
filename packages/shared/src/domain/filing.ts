import { panelPlace, panelGathers, panelTakesItems } from './panel.js';
import type { Filing, Panel } from './panel.js';
import type { Dashboard, Item } from './item.js';

/**
 * What a panel holds and what the Inbox holds, derived from one Workspace's
 * snapshot ("Panels hold the items filed into them, and the Inbox holds the
 * rest", issue 36): pure rules the browser and the Worker answer by alike.
 *
 * **The Inbox is the absence of a filing**, not a panel with rows of its own,
 * which is what makes filing an item the thing that takes it out of the Inbox.
 */

/**
 * Whether an item is still yours to deal with, which is the whole of what an
 * item can be besides finished with ("An item is either yours to deal with or
 * finished with", issue 154).
 *
 * Dismissed items never reach the client at all - the snapshot leaves them out
 * server-side - and finished ones do, so this is what keeps a completed item
 * off the panel it was filed on as well as out of the Inbox. One predicate for
 * both lists, because "gone from the Inbox but still on a panel" is a
 * distinction nobody asked for.
 *
 * **They arrive so that undoing has something to put back.** A finished item
 * has to be in the copy the browser holds for the bar offering to undo it to
 * work without a round trip.
 */
export function stillOpen(item: Item): boolean {
  return item.completedAt === null;
}

/**
 * Everything still to deal with that is filed nowhere - the Inbox.
 *
 * The snapshot leaves out the filings of deleted panels, so an item whose only
 * panel has gone is back here without anything on this side knowing that a
 * panel was ever deleted.
 */
export function itemsInTheInbox(items: readonly Item[], filings: readonly Filing[]): Item[] {
  const filed = new Set(filings.map((filing) => filing.itemId));
  return items.filter((item) => stillOpen(item) && !filed.has(item.id));
}

/**
 * Everything still to deal with that is filed somewhere - the complement of
 * `itemsInTheInbox`, built the same direct way from `filings` rather than by
 * inverting that function's own result, so a caller needing both sides of the
 * partition (`possibleDuplicatesOf`, issue 410) pays for one scan each rather
 * than one twice over.
 */
export function itemsThatAreFiled(items: readonly Item[], filings: readonly Filing[]): Item[] {
  const filed = new Set(filings.map((filing) => filing.itemId));
  return items.filter((item) => stillOpen(item) && filed.has(item.id));
}

/**
 * The filings that file: every one onto a panel that takes items filed onto it.
 *
 * **A filing onto a Filter is no filing at all** ("Add a Filter panel that shows
 * every filed item due in a window", issue 463). Nothing offers one and the
 * server refuses one, so the only way to make one is against a release that
 * predates Filters - which reads a Filter as an empty panel of items and
 * accepts it. Counting it would take the item out of the Inbox and hand it to a
 * panel that draws what it gathers rather than what is filed on it, leaving the
 * item on no screen at all.
 *
 * **The workspace's panels, never one dashboard's**, which is what the
 * parameter is named for: a filing names a Panel and says nothing about which
 * dashboard is on screen, so a caller passing the panels it happens to be
 * drawing recognises only the Filters that share a dashboard with them - and
 * the Inbox, which always reads workspace-wide, then disagrees with it about
 * the same Item. The board did exactly that until the review on issue 463.
 *
 * A filing whose panel the snapshot does not carry still files, which is the
 * behaviour that was already there: the Inbox is the absence of a filing, and a
 * missing panel is not a reason to decide the filing never happened. That is
 * why the rule above cannot be enforced here - a short list and a stale one
 * look the same.
 *
 * **The list itself where there is no Filter to leave out**, rather than a copy
 * of it: every workspace that has never made one is every workspace today, and
 * half a dozen call sites ask this on each render.
 */
export function filingsThatFile(
  filings: readonly Filing[],
  panelsInWorkspace: readonly Panel[],
): readonly Filing[] {
  const gathering = new Set(panelsInWorkspace.filter(panelGathers).map((panel) => panel.id));
  if (gathering.size === 0) return filings;
  return filings.filter((filing) => !gathering.has(filing.panelId));
}

/**
 * Where an item is filed, as "Dashboard ▸ Panel" for each Panel that takes
 * items, or none to name.
 *
 * A filing onto a Filter is no filing (`filingsThatFile`), and one whose Panel
 * the snapshot no longer carries is a deleted Panel's: both leave the item in
 * the Inbox, which is what reopening it will do.
 */
export function placesFiledOn(
  item: Item,
  filings: readonly Filing[],
  panels: readonly Panel[],
  dashboards: readonly Dashboard[],
): string[] {
  const held = new Set(filings.filter((filing) => filing.itemId === item.id).map((f) => f.panelId));
  return panels
    .filter((panel) => held.has(panel.id) && panelTakesItems(panel))
    .map((panel) => {
      const dashboard = dashboards.find((candidate) => candidate.id === panel.dashboardId);
      return dashboard ? panelPlace(dashboard.name, panel.name) : panel.name;
    });
}

/**
 * What *All items* says in its *Where it is* column: each Panel the item is
 * filed on (`placesFiledOn`), joined with a comma, or *Inbox* for an item never
 * filed.
 */
export function whereItIs(
  item: Item,
  filings: readonly Filing[],
  panels: readonly Panel[],
  dashboards: readonly Dashboard[],
): string {
  const places = placesFiledOn(item, filings, panels, dashboards);
  return places.length > 0 ? places.join(', ') : 'Inbox';
}
