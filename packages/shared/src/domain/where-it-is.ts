import type { Dashboard, Item } from './item.js';
import { panelPlace, panelTakesItems } from './panel.js';
import type { Filing, Panel } from './panel.js';

/**
 * Where an Item is, as *All items* says it ("Put each setting where a person
 * looks for it", issue 688) and as the MCP `find_items` tool says it: each
 * Panel it is filed on, or *Inbox*.
 */

/** What the *Where it is* column says for an Item filed on nothing. */
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
  panels: readonly Panel[],
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

/** The column's text for an Item: its places joined, or *Inbox* for one filed nowhere. */
export function whereItIs(places: readonly string[]): string {
  return places.length > 0 ? places.join(', ') : INBOX_PLACE;
}
