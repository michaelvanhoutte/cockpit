import { panelGathers, panelTakesItems } from '@cockpit/shared';
import type {
  Panel,
  PanelSort,
  SortCriterion,
  SortDirection,
  SortField,
} from '@cockpit/shared';

/**
 * How a sorted Panel of items draws its rows ("Sort a panel of items by the
 * fields you choose", issue 526), worked out in the client for the reason a
 * Filter's rows are (`@cockpit/shared`'s `filters.ts`): the wire carries the Panel's sort and its
 * filings, and nothing about the order that makes. The ordering itself
 * (`inSortOrder`) and a Filter's default sort are `@cockpit/shared`'s.
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
