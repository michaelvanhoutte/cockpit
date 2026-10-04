import {
  UNTITLED,
  itemStatus,
  panelPlace,
  panelTakesItems,
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
 * **A view over the snapshot**, like the Inbox (`filing.ts`): finished items
 * travel in it and dismissed ones do not, so the table is the snapshot's items
 * as they stand and asks the server for nothing. It is sorted and filtered over
 * every row, then drawn `ALL_ITEMS_PAGE` at a time.
 */

/** How many rows are drawn before *Show more*. */
export const ALL_ITEMS_PAGE = 50;

/**
 * Where an item is filed, as "Dashboard ▸ Panel" for each Panel that takes
 * items, or none to name.
 *
 * A filing onto a Filter is no filing (`filingsThatFile`), and one whose Panel
 * the snapshot no longer carries is a deleted Panel's: both leave the item in
 * the Inbox, which is what reopening it will do.
 */
export function placesFiledOn(
  item: Item,
  filings: readonly Filing[],
  panels: readonly Panel[],
  dashboards: readonly Dashboard[],
): string[] {
  const held = new Set(filings.filter((filing) => filing.itemId === item.id).map((f) => f.panelId));
  return panels
    .filter((panel) => held.has(panel.id) && panelTakesItems(panel))
    .map((panel) => {
      const dashboard = dashboards.find((candidate) => candidate.id === panel.dashboardId);
      return dashboard ? panelPlace(dashboard.name, panel.name) : panel.name;
    });
}

export type AllItemsKey = 'title' | 'type' | 'status' | 'priority' | 'due' | 'where' | 'changed';

export const ALL_ITEMS_COLUMNS: readonly { key: AllItemsKey; label: string }[] = [
  { key: 'title', label: 'Title' },
  { key: 'type', label: 'Type' },
  { key: 'status', label: 'Status' },
  { key: 'priority', label: 'Priority' },
  { key: 'due', label: 'Due' },
  { key: 'where', label: 'Where it is' },
  { key: 'changed', label: 'Last changed' },
];

export const STATUS_LABELS: Record<ItemStatus, string> = {
  to_do: 'To do',
  in_progress: 'In progress',
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
  /** The Type's name, or empty for an item with none or whose Type has been deleted. */
  type: string;
  status: ItemStatus;
  priority: Priority | null;
  due: string | null;
  /** "Dashboard ▸ Panel" for each panel, or *Inbox* for an item never filed. */
  where: string;
  /** The finish for a done item, otherwise its last edit. */
  changedAt: string;
}

const PRIORITY_RANK: Record<Priority, number> = { high: 0, normal: 1, low: 2 };
const STATUS_RANK: Record<ItemStatus, number> = { to_do: 0, in_progress: 1, done: 2 };

function sortValue(row: AllItemsRow, key: AllItemsKey): string | number {
  switch (key) {
    case 'title':
      return row.title.toLowerCase();
    case 'type':
      return row.type.toLowerCase();
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
 *
 * The lists besides the items are optional: a stored copy rehydrated from
 * IndexedDB is not parsed again, so one taken before a field existed lacks it.
 */
export function allItemsRows(
  snapshot: {
    items: readonly Item[];
    filings?: readonly Filing[] | undefined;
    panels?: readonly Panel[] | undefined;
    dashboards?: readonly Dashboard[] | undefined;
    itemTypes?: readonly { id: string; name: string }[] | undefined;
  },
  sort: AllItemsSort = DEFAULT_SORT,
): AllItemsRow[] {
  const rows = snapshot.items.map((item): AllItemsRow => {
    const places = placesFiledOn(item, snapshot.filings ?? [], snapshot.panels ?? [], snapshot.dashboards ?? []);
    return {
      item,
      title: item.title.trim() || UNTITLED,
      type: (snapshot.itemTypes ?? []).find((type) => type.id === item.typeId)?.name ?? '',
      status: itemStatus(item),
      priority: item.priority ?? null,
      due: item.dueDate ?? null,
      where: places.length > 0 ? places.join(', ') : 'Inbox',
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
