import { ancestorIdsOf, type ChildRow } from '@cockpit/shared';

/**
 * Where a dragged row would land on another row, said on every `dragover`
 * ("Drag to nest in Panels and the Inbox", issue 1857). Kept apart from the
 * plan a drop comes to (`nesting.ts`), which is fetched only once a drag is
 * under way, so the initial bundle carries only this.
 *
 * **Pure**, for the reason `dropAt.ts` is: jsdom reports every box as zero, and
 * what a test can prove is the arithmetic once the boxes are given.
 */

/** The part of a row the pointer is on: the middle half is inside it, the top and bottom quarters the gap beside it. */
export type WhereOnARow = 'inside' | 'before' | 'after';

interface Box {
  top: number;
  height: number;
  left: number;
  width: number;
}

/**
 * Where on `box` the pointer is. In columns a row is a card with a left and a
 * right half to aim at the gap beside it, so the middle half is across as well
 * as down (`landingOnRow`, panelColumns.ts).
 */
export function whereOnARow(box: Box, x: number, y: number, inColumns = false): WhereOnARow {
  const down = (y - box.top) / box.height;
  const across = (x - box.left) / box.width;
  if (down <= 0.25) return 'before';
  if (down >= 0.75) return 'after';
  if (inColumns && (across <= 0.25 || across >= 0.75)) return across <= 0.25 ? 'before' : 'after';
  return 'inside';
}

/**
 * That nothing may go inside `target` from what is carried: it is one of the
 * Items carried, or is inside one of them, however deep - which the server
 * refuses too, but a pointer that says no before the drop is the better answer
 * (decision 6 of "Panels and the Inbox: an Item can only be put inside another
 * through menus", issue 1854).
 */
export function refusesNesting(carried: readonly string[], target: string, rows: readonly ChildRow[]): boolean {
  if (carried.includes(target)) return true;
  const above = ancestorIdsOf(rows, target);
  return carried.some((id) => above.has(id));
}
