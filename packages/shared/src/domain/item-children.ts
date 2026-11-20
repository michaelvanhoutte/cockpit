import { z } from 'zod';
import type { Item } from './item.js';

/**
 * An Item held by another Item ("Brainstorming: an Item can't hold other
 * Items", issue 1825): *Storm scene* inside *Chapter 3*. An Item can sit in
 * several, and the order is the parent's. A Panel is never a parent: what
 * is filed on it is `filings` (issue 1846), so a row here always names an Item.
 */
export const childRowSchema = z.object({
  parentId: z.string(),
  childId: z.string(),
  position: z.number(),
});
export type ChildRow = z.infer<typeof childRowSchema>;

/** The most Items one *Add as child of…* takes at once: a screenful of picked rows. */
export const CHILDREN_ADDED_AT_ONCE = 50;

/** The ids of the Items holding this one, in the order the rows came. */
export function parentIdsOf(rows: readonly ChildRow[], itemId: string): string[] {
  return [...new Set(rows.filter((row) => row.childId === itemId).map((row) => row.parentId))];
}

/** Whether an Item holds anything, by the count kept on it rather than the rows a snapshot happens to carry. */
export function holdsItems(item: Pick<Item, 'childrenCount'>): boolean {
  return (item.childrenCount ?? 0) > 0;
}

/** "2 of 3 done", from the counts kept on the parent, so a child finished long ago still counts. */
export function doneOfHeld(item: Pick<Item, 'childrenCount' | 'childrenDone'>): string {
  return `${item.childrenDone ?? 0} of ${item.childrenCount ?? 0} done`;
}
