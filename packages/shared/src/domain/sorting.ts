import type { Item, Priority } from './item.js';
import { panelGathers, panelTakesItems } from './panel.js';
import type { Panel, PanelSort, SortField } from './panel.js';

/**
 * How a sorted Panel of items draws its rows ("Sort a panel of items by the
 * fields you choose", issue 526): the order a sort puts Items in, shared so
 * the browser and an app reading Items over MCP order them alike. What each
 * field and direction is called is the browser's (`sorting.ts`).
 */

/**
 * How a Panel draws its rows by a sort of its own, or null where it has none -
 * the one reading the board, the mark and the drag all ask, so they cannot
 * disagree about a Panel.
 *
 * For a Panel of items none is Manual; for a Filter none is the order nobody
 * has changed (`DEFAULT_FILTER_SORT`), which is why the mark stays off it. A
 * Panel of text is not sorted at all.
 */
export function sortOf(panel: Panel): PanelSort | null {
  return panelTakesItems(panel) || panelGathers(panel) ? panel.sort : null;
}

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


/**
 * A Filter's rows, in the order they are drawn: by its sort, then oldest first
 * wherever that leaves two tied ("Choose how a Filter's rows are sorted", issue
 * 527).
 *
 * Its own function because a Filter's last tie-break is its own rule: a sorted
 * Panel ends on the order you set, and a Filter has none. Adding Created
 * ascending where the sort does not name it is that rule, and changes nothing
 * where it does. An Item with no value for a criterion goes last in either
 * direction, which is what lets a Filter with only a Priority
 * condition mix dated and undated Items freely.
 */
export function inFilterOrder(items: readonly Item[], sort: PanelSort): Item[] {
  const withTheTie = sort.some((criterion) => criterion.field === 'createdAt')
    ? sort
    : [...sort, { field: 'createdAt' as const, direction: 'asc' as const }];
  return inSortOrder(items, withTheTie);
}
