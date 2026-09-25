import type {
  Item,
  ItemType,
  PanelSort,
  Priority,
  SortCriterion,
  SortDirection,
  SortField,
} from '@cockpit/shared';

/**
 * How a sorted Panel of items draws its rows ("Sort a panel of items by the
 * fields you choose", issue 526), worked out in the client for the reason a
 * Filter's rows are (`filters.ts`): the wire carries the Panel's sort and its
 * filings, and nothing about the order that makes.
 */

/** What each field is called in the Sort question and in the mark's sentence. */
export const SORT_FIELD_LABELS: Record<SortField, string> = {
  title: 'Title',
  priority: 'Priority',
  createdAt: 'Created',
  dueDate: 'Due date',
  type: 'Type',
};

/** What each direction means for each field, which hovering the direction says. */
export const SORT_DIRECTION_MEANS: Record<SortField, Record<SortDirection, string>> = {
  title: { asc: 'A to Z', desc: 'Z to A' },
  priority: { asc: 'Low to High', desc: 'High to Low' },
  createdAt: { asc: 'Oldest first', desc: 'Newest first' },
  dueDate: { asc: 'Soonest first', desc: 'Latest first' },
  type: { asc: 'In the order of your Types', desc: 'The order of your Types, reversed' },
};

/**
 * The direction a row starts on when it is added: Descending for Priority,
 * because the High ones are what a sort by Priority is asked for, and Ascending
 * for every other.
 */
export function directionFor(field: SortField): SortDirection {
  return field === 'priority' ? 'desc' : 'asc';
}

const PRIORITY_RANK: Record<Priority, number> = { low: 0, normal: 1, high: 2 };

/** A to Z, ignoring case. */
const titles = new Intl.Collator(undefined, { sensitivity: 'accent' });

/**
 * One Item's value for one field, or null where it has none - no title, no
 * priority, no due date, no Type or a Type since deleted. `typeRank` is the
 * place of each live Type in the order you put them in.
 */
function valueOf(
  item: Item,
  field: SortField,
  typeRank: ReadonlyMap<string, number>,
): string | number | null {
  if (field === 'title') return item.title.trim() || null;
  if (field === 'priority') return item.priority ? PRIORITY_RANK[item.priority] : null;
  if (field === 'createdAt') return item.createdAt;
  if (field === 'dueDate') return item.dueDate ?? null;
  return item.typeId === null ? null : (typeRank.get(item.typeId) ?? null);
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
 * untitled rows to the top.
 */
export function inSortOrder(
  items: readonly Item[],
  sort: PanelSort,
  itemTypes: readonly ItemType[],
): Item[] {
  const typeRank = new Map(itemTypes.map((type, at) => [type.id, at]));
  return items.slice().sort((one, other) => {
    for (const { field, direction } of sort) {
      const a = valueOf(one, field, typeRank);
      const b = valueOf(other, field, typeRank);
      if (a === null && b === null) continue;
      if (a === null) return 1;
      if (b === null) return -1;
      const compared = compareValues(field, a, b);
      if (compared !== 0) return direction === 'desc' ? -compared : compared;
    }
    return 0;
  });
}

/** One criterion as the mark reads it back: *Due date ascending*. */
function saidAs(criterion: SortCriterion): string {
  const direction = criterion.direction === 'asc' ? 'ascending' : 'descending';
  return `${SORT_FIELD_LABELS[criterion.field]} ${direction}`;
}

/** The sort as a sentence, which the mark beside a sorted Panel's name reads back on hover. */
export function saysHowItIsSorted(sort: PanelSort): string {
  return `Sorted: ${sort.map(saidAs).join(', then ')}`;
}
