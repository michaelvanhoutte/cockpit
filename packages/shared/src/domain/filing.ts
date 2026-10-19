import type { Item } from './item.js';
import { panelGathers, type Filing, type Panel } from './panel.js';

/**
 * What a panel holds and what the Inbox holds, derived from the one snapshot a
 * Workspace reads ("Panels hold the items filed into them, and the Inbox holds
 * the rest", issue 36) - shared so the browser that draws them and the Worker
 * that answers a connected app's `find_items` ("Find items in Cockpit from a
 * connected app, over MCP", issue 1240) say the same.
 *
 * **The Inbox is the absence of a filing**, not a panel with rows of its own.
 */

/**
 * Whether an item is still yours to deal with, which is the whole of what an
 * item can be besides finished with ("An item is either yours to deal with or
 * finished with", issue 154). One predicate for both lists, because "gone from
 * the Inbox but still on a panel" is a distinction nobody asked for.
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
 * partition pays for one scan each rather than one twice over.
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
 * the same Item.
 *
 * A filing whose panel the snapshot does not carry still files: the Inbox is
 * the absence of a filing, and a missing panel is not a reason to decide the
 * filing never happened.
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
