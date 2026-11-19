import { itemLabel, type Dashboard, type Item } from './item.js';
import { placesFiledOn, stillOpen } from './filing.js';
import type { Filing, Panel } from './panel.js';
import type { ChildRow } from './item-children.js';

/**
 * Reading where an Item sits among the Items holding it ("Brainstorming: an
 * Item can't hold other Items", issue 1825), for the screens that draw it: a
 * parent's child rows, Relations, Find and *All items*. Apart from
 * item-children.ts, which the rows on every screen need, so a browser fetches
 * these only with those screens.
 */

/** Which of two rows of one parent comes first, as `byPlaceOnPanel` orders a Panel's. */
function byPlace(a: ChildRow, b: ChildRow): number {
  return a.position - b.position || (a.childId < b.childId ? -1 : a.childId > b.childId ? 1 : 0);
}

/**
 * The open Items a parent holds, in its order: what its row unfolds to. An id
 * the snapshot does not carry (finished long ago, dismissed in another tab)
 * is skipped, as `itemsOnPanel` skips one.
 */
export function childrenOf(rows: readonly ChildRow[], items: readonly Item[], parentId: string): Item[] {
  const byId = new Map(items.filter(stillOpen).map((item) => [item.id, item]));
  return rows
    .filter((row) => row.parentId === parentId)
    .slice()
    .sort(byPlace)
    .map((row) => byId.get(row.childId))
    .filter((item): item is Item => item !== undefined);
}

/** The ids of the Items this one holds that the snapshot carries, in its order. */
export function childIdsOf(rows: readonly ChildRow[], itemId: string): string[] {
  return rows
    .filter((row) => row.parentId === itemId)
    .slice()
    .sort(byPlace)
    .map((row) => row.childId);
}

/** Every Item above this one, as far as the rows go: what has to be unfolded for its row to be drawn. */
export function ancestorIdsOf(rows: readonly ChildRow[], itemId: string): Set<string> {
  const found = new Set<string>();
  const next = [itemId];
  while (next.length > 0) {
    const at = next.pop()!;
    for (const row of rows) {
      if (row.childId === at && !found.has(row.parentId)) {
        found.add(row.parentId);
        next.push(row.parentId);
      }
    }
  }
  return found;
}

/**
 * Every Item below this one, as far as the rows go: what may not become its
 * parent, since an Item never sits inside itself. The server walks the whole
 * tree and refuses; this only keeps the picker from offering what it would.
 */
export function descendantIdsOf(rows: readonly ChildRow[], itemId: string): Set<string> {
  const found = new Set<string>();
  const next = [itemId];
  while (next.length > 0) {
    const at = next.pop()!;
    for (const row of rows) {
      if (row.parentId === at && !found.has(row.childId)) {
        found.add(row.childId);
        next.push(row.childId);
      }
    }
  }
  return found;
}

/**
 * The names of the Items holding this one, for saying where it is when it is
 * on no Panel: then it is not in the Inbox either. One the Items given leave
 * out is "an Item".
 */
export function insideOf(itemId: string, children: readonly ChildRow[], items: readonly Item[]): string[] {
  const byId = new Map(items.map((one) => [one.id, one]));
  return [...new Set(children.filter((row) => row.childId === itemId).map((row) => row.parentId))].map((id) => {
    const parent = byId.get(id);
    return parent ? itemLabel(parent) : 'an Item';
  });
}

/**
 * What *All items* says in its *Where it is* column: each Panel the item is
 * filed on (`placesFiledOn`), joined with a comma, else the Items holding it
 * (`insideOf`), else *Inbox*.
 */
export function whereItSits(
  item: Item,
  filings: readonly Filing[],
  panels: readonly Panel[],
  dashboards: readonly Dashboard[],
  children: readonly ChildRow[] = [],
  items: readonly Item[] = [],
): string {
  const places = placesFiledOn(item, filings, panels, dashboards);
  if (places.length > 0) return places.join(', ');
  const inside = insideOf(item.id, children, items);
  return inside.length > 0 ? `Inside ${inside.join(', ')}` : 'Inbox';
}
