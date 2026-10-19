import type { PanelSort, SortCriterion, SortDirection, SortField } from '@cockpit/shared';

export { DEFAULT_FILTER_SORT, inFilterOrder, inSortOrder, sortOf } from '@cockpit/shared';

/**
 * How a sorted Panel of items draws its rows ("Sort a panel of items by the
 * fields you choose", issue 526): what a sort is called and read back as. The
 * order it puts Items in is shared (`@cockpit/shared`, `domain/sorting.ts`) and
 * re-exported above.
 */

/** What each field is called in the Sort question and in the mark's sentence. */
export const SORT_FIELD_LABELS: Record<SortField, string> = {
  title: 'Title',
  priority: 'Priority',
  createdAt: 'Created',
  dueDate: 'Due date',
};

/** What each direction means for each field, which hovering the direction says. */
export const SORT_DIRECTION_MEANS: Record<SortField, Record<SortDirection, string>> = {
  title: { asc: 'A to Z', desc: 'Z to A' },
  priority: { asc: 'Low to High', desc: 'High to Low' },
  createdAt: { asc: 'Oldest first', desc: 'Newest first' },
  dueDate: { asc: 'Soonest first', desc: 'Latest first' },
};

/**
 * The direction a row starts on when it is added: Descending for Priority,
 * because the High ones are what a sort by Priority is asked for, and Ascending
 * for every other.
 */
export function directionFor(field: SortField): SortDirection {
  return field === 'priority' ? 'desc' : 'asc';
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
