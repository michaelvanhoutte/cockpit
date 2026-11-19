import { z } from 'zod';
import type { Item } from './item.js';
import { stillOpen } from './filing.js';

/**
 * An Item held by another Item ("Brainstorming: an Item can't hold other
 * Items", issue 1825): *Storm scene* inside *Chapter 3*. An Item can sit in
 * several, and the order is the parent's. A Panel's own Item holds what is
 * filed on the Panel, which the snapshot carries as `filings` instead, so a
 * row here always names an Item parent.
 */
export const childRowSchema = z.object({
  parentId: z.string(),
  childId: z.string(),
  position: z.number(),
});
export type ChildRow = z.infer<typeof childRowSchema>;

/** The most Items one *Add as child of…* takes at once: a screenful of picked rows. */
export const CHILDREN_ADDED_AT_ONCE = 50;

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

/** The ids of the Items holding this one, in the order the rows came. */
export function parentIdsOf(rows: readonly ChildRow[], itemId: string): string[] {
  return [...new Set(rows.filter((row) => row.childId === itemId).map((row) => row.parentId))];
}

/** The ids of the Items this one holds that the snapshot carries, in its order. */
export function childIdsOf(rows: readonly ChildRow[], itemId: string): string[] {
  return rows
    .filter((row) => row.parentId === itemId)
    .slice()
    .sort(byPlace)
    .map((row) => row.childId);
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

/** Whether an Item holds anything, by the count kept on it rather than the rows a snapshot happens to carry. */
export function holdsItems(item: Pick<Item, 'childrenCount'>): boolean {
  return (item.childrenCount ?? 0) > 0;
}

/** "2 of 3 done", from the counts kept on the parent, so a child finished long ago still counts. */
export function doneOfHeld(item: Pick<Item, 'childrenCount' | 'childrenDone'>): string {
  return `${item.childrenDone ?? 0} of ${item.childrenCount ?? 0} done`;
}
