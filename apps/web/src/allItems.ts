import {
  UNTITLED,
  itemStatus,
  whereItIs,
  type Dashboard,
  type Filing,
  type Item,
  type ItemStatus,
  type Panel,
  type Priority,
} from '@cockpit/shared';

/**
 * The table on *All items* ("Put each setting where a person looks for it",
 * issue 688): every item of the workspace in one table, and how it is ordered.
 *
 * **A view over the snapshot**, like the Inbox (`packages/shared/src/domain/filing.ts`): finished items
 * travel in it and dismissed ones do not, so the table is the snapshot's items
 * as they stand and asks the server for nothing. It is sorted and filtered over
 * every row, then drawn `ALL_ITEMS_PAGE` at a time.
 */

/** How many rows are drawn before *Show more*. */
export const ALL_ITEMS_PAGE = 50;

export type AllItemsKey = 'title' | 'status' | 'priority' | 'due' | 'where' | 'changed';

export const ALL_ITEMS_COLUMNS: readonly { key: AllItemsKey; label: string }[] = [
  { key: 'title', label: 'Title' },
  { key: 'status', label: 'Status' },
  { key: 'priority', label: 'Priority' },
  { key: 'due', label: 'Due' },
  { key: 'where', label: 'Where it is' },
  { key: 'changed', label: 'Last changed' },
];

export const STATUS_LABELS: Record<ItemStatus, string> = {
  to_do: 'To do',
  in_progress: 'In progress',
  waiting: 'Waiting for reply',
  done: 'Done',
};

export interface AllItemsSort {
  key: AllItemsKey;
  /** Reversed: largest first. */
  down: boolean;
}

/** Newest changed first, before anything is pressed. */
export const DEFAULT_SORT: AllItemsSort = { key: 'changed', down: true };

/** What pressing a header does: a new column is ascending, the same one again reverses. Time starts newest first. */
export function pressHeader(sort: AllItemsSort, key: AllItemsKey): AllItemsSort {
  if (sort.key === key) return { key, down: !sort.down };
  return { key, down: key === 'changed' };
}

export interface AllItemsRow {
  item: Item;
  title: string;
  status: ItemStatus;
  priority: Priority | null;
  due: string | null;
  /** "Dashboard ▸ Panel" for each panel, or *Inbox* for an item never filed. */
  where: string;
  /** The finish for a done item, otherwise its last edit. */
  changedAt: string;
}

const PRIORITY_RANK: Record<Priority, number> = { high: 0, normal: 1, low: 2 };
const STATUS_RANK: Record<ItemStatus, number> = { to_do: 0, in_progress: 1, waiting: 2, done: 3 };

function sortValue(row: AllItemsRow, key: AllItemsKey): string | number {
  switch (key) {
    case 'title':
      return row.title.toLowerCase();
    case 'status':
      return STATUS_RANK[row.status];
    case 'priority':
      return row.priority ? PRIORITY_RANK[row.priority] : 3;
    case 'due':
      return row.due ?? '9999-99-99';
    case 'where':
      return row.where.toLowerCase();
    case 'changed':
      return Date.parse(row.changedAt);
  }
}

/**
 * Every item of the snapshot as a row, ordered. Equal rows keep the newest
 * change first, so a column of the same value is never in an arbitrary order.
 */
export function allItemsRows(
  snapshot: {
    items: readonly Item[];
    filings: readonly Filing[];
    panels: readonly Panel[];
    dashboards: readonly Dashboard[];
  },
  sort: AllItemsSort = DEFAULT_SORT,
): AllItemsRow[] {
  const rows = snapshot.items.map((item): AllItemsRow => {
    return {
      item,
      title: item.title.trim() || UNTITLED,
      status: itemStatus(item),
      priority: item.priority ?? null,
      due: item.dueDate ?? null,
      where: whereItIs(item, snapshot.filings, snapshot.panels, snapshot.dashboards),
      changedAt: item.completedAt ?? item.updatedAt,
    };
  });
  return rows.sort((a, b) => {
    const [x, y] = [sortValue(a, sort.key), sortValue(b, sort.key)];
    const order = x < y ? -1 : x > y ? 1 : 0;
    if (order !== 0) return sort.down ? -order : order;
    return Date.parse(b.changedAt) - Date.parse(a.changedAt);
  });
}
