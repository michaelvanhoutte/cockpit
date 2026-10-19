import { panelPlace, panelTakesItems, type Filing, type Panel } from './panel.js';
import type { Dashboard, Item } from './item.js';

/**
 * Where an item is, as *All items* says it in its *Where it is* column ("Put
 * each setting where a person looks for it", issue 688) - shared so a connected
 * app's `find_items` ("Find items in Cockpit from a connected app, over MCP",
 * issue 1240) names a place as the screen does.
 */

/** What a row says for an item filed nowhere. */
export const INBOX_PLACE = 'Inbox';

/**
 * Where an item is filed, as "Dashboard ▸ Panel" for each Panel that takes
 * items, or none to name.
 *
 * A filing onto a Filter is no filing (`filingsThatFile`), and one whose Panel
 * the snapshot no longer carries is a deleted Panel's: both leave the item in
 * the Inbox, which is what reopening it will do.
 */
export function placesFiledOn(
  item: Pick<Item, 'id'>,
  filings: readonly Filing[],
  panels: readonly Pick<Panel, 'id' | 'kind' | 'dashboardId' | 'name'>[],
  dashboards: readonly Pick<Dashboard, 'id' | 'name'>[],
): string[] {
  const held = new Set(filings.filter((filing) => filing.itemId === item.id).map((f) => f.panelId));
  return panels
    .filter((panel) => held.has(panel.id) && panelTakesItems(panel))
    .map((panel) => {
      const dashboard = dashboards.find((candidate) => candidate.id === panel.dashboardId);
      return dashboard ? panelPlace(dashboard.name, panel.name) : panel.name;
    });
}

/** The *Where it is* column's own words: every place joined, or *Inbox* for an item never filed. */
export function whereItIs(places: readonly string[]): string {
  return places.length > 0 ? places.join(', ') : INBOX_PLACE;
}
