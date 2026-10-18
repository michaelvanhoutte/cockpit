import type { Item, Priority } from './item.js';
import type { PanelSort, SortField } from './panel.js';

/**
 * How a sorted Panel of items puts its rows in order ("Sort a panel of items by
 * the fields you choose", issue 526), shared so the browser that draws a Filter
 * and the Worker that answers for one put the same Items first.
 */

/**
 * What a Filter nobody has sorted goes by - Due date ascending, then Priority
 * descending, then Created ascending - so choosing nothing changes nothing on
 * screen ("Choose how a Filter's rows are sorted", issue 527).
 */
export const DEFAULT_FILTER_SORT: PanelSort = [
  { field: 'dueDate', direction: 'asc' },
  { field: 'priority', direction: 'desc' },
  { field: 'createdAt', direction: 'asc' },
];

const PRIORITY_RANK: Record<Priority, number> = { low: 0, normal: 1, high: 2 };

/** A to Z, ignoring case. */
const titles = new Intl.Collator(undefined, { sensitivity: 'accent' });

/**
 * One Item's value for one field, or null where it has none - no title, no
 * priority, no due date.
 */
function valueOf(item: Item, field: SortField): string | number | null {
  if (field === 'title') return item.title.trim() || null;
  if (field === 'priority') return item.priority ? PRIORITY_RANK[item.priority] : null;
  if (field === 'createdAt') return item.createdAt;
  return item.dueDate ?? null;
}

function compareValues(field: SortField, one: string | number, other: string | number): number {
  if (field === 'title') return titles.compare(one as string, other as string);
  if (one === other) return 0;
  return one < other ? -1 : 1;
}

/**
 * A Panel's rows in the order its sort puts them: by the first criterion, then
 * the next wherever two tie, then the order they arrived in - which, handed
 * the order you set, is the last tie-break the issue asks for. `Array.sort` is
 * stable, which is what that last step leans on.
 *
 * **An Item with no value for a criterion goes after every Item that has one,
 * in either direction**, so turning a sort round never brings the undated or
 * untitled rows to the top. Manual (null) is the order handed in.
 */
export function inSortOrder(items: readonly Item[], sort: PanelSort | null): Item[] {
  if (sort === null) return [...items];
  return items.slice().sort((one, other) => {
    for (const { field, direction } of sort) {
      const a = valueOf(one, field);
      const b = valueOf(other, field);
      if (a === null && b === null) continue;
      if (a === null) return 1;
      if (b === null) return -1;
      const compared = compareValues(field, a, b);
      if (compared !== 0) return direction === 'desc' ? -compared : compared;
    }
    return 0;
  });
}
