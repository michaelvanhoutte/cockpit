import { useCallback, useMemo, useSyncExternalStore } from 'react';
import {
  DUE_WINDOWS,
  ITEM_STATUSES,
  itemStatus,
  type AgentRun,
  type Attachment,
  type DueWindow,
  type Item,
  type ItemStatus,
  type Priority,
} from '@cockpit/shared';
import { dueHolds, type Day } from './filters';

/**
 * A Dashboard filter: six conditions, all of which must hold, narrowing what
 * the Panels of items and Filter panels already on one Dashboard show
 * ("Filter a dashboard by priority, due date, text and attachments", issue 633).
 *
 * **Remembered in the browser, per Dashboard, not in the database** - the
 * reason the last view of a workspace is (lastVisited.ts): it is a way of
 * looking, and nothing about it is worth a write, an invalidation and a push
 * for another device that was not looking this way. An unset condition stores
 * nothing, so a Dashboard with no filter has no entry at all.
 *
 * The storage is handed in rather than reached for, so the deciding is provable
 * without a browser and so a private window, or a browser that refuses or
 * garbles storage, is a Dashboard drawn unfiltered rather than one that throws.
 */

/** A Priority, or the absence of one - which a Dashboard filter, unlike a Filter panel, can ask for. */
export type PriorityChoice = Priority | 'none';

export type AttachmentsChoice = 'any' | 'with' | 'without';

export type DashboardFilter = {
  /** Any of these statuses, an empty list meaning every status. */
  statuses: ItemStatus[];
  /** Any of these, an empty list meaning every Priority. */
  priorities: PriorityChoice[];
  /** The window an Item's due date falls in, or null for any time. */
  due: { window: DueWindow; orOverdue: boolean } | null;
  /** Case-insensitive, over the title, the description and the next action. */
  text: string;
  attachments: AttachmentsChoice;
  /** Only Items with an open run, whatever its status - a refused start included, which still shows its chip. */
  agentRunning: boolean;
};

export const NO_DASHBOARD_FILTER: DashboardFilter = {
  statuses: [],
  priorities: [],
  due: null,
  text: '',
  attachments: 'any',
  agentRunning: false,
};

/** What an arrangement control says while a Dashboard filter is on: the filter fits the rows to what is left, so none can be rearranged. */
export const CLEAR_THE_FILTER_FIRST = 'Clear the dashboard filter first';

const PRIORITY_CHOICES: readonly PriorityChoice[] = ['high', 'normal', 'low', 'none'];
const ATTACHMENT_CHOICES: readonly AttachmentsChoice[] = ['any', 'with', 'without'];

/** Whether any of the six conditions is set - which is all "filtered" means. */
export function isFiltering(filter: DashboardFilter): boolean {
  return (
    filter.statuses.length > 0 ||
    filter.priorities.length > 0 ||
    filter.due !== null ||
    filter.text.trim() !== '' ||
    filter.attachments !== 'any' ||
    filter.agentRunning
  );
}

/**
 * The *Containing* rule: whether the text, trimmed and case-insensitive, is in
 * the title, the description or the next action. Nothing typed matches
 * everything. Shared with the list of items marked done (`markedDone.ts`), so
 * the two never disagree about what a search matches.
 */
export function containsText(
  item: Pick<Item, 'title' | 'description' | 'nextAction'>,
  text: string,
): boolean {
  const needle = text.trim().toLowerCase();
  if (!needle) return true;
  const haystack = [item.title, item.description ?? '', item.nextAction ?? ''].join('\n');
  return haystack.toLowerCase().includes(needle);
}

/**
 * Whether an Item meets every condition that is set, on the day the person is
 * looking.
 *
 * **The Due condition is a Filter panel's** (`dueHolds`), *or overdue*
 * included, so the two never disagree about what "this week" means.
 */
export function matchesDashboardFilter(
  filter: DashboardFilter,
  item: Item,
  withAttachments: ReadonlySet<string>,
  on: Day,
  withRun: ReadonlySet<string>,
): boolean {
  if (filter.statuses.length > 0 && !filter.statuses.includes(itemStatus(item))) return false;
  if (
    filter.priorities.length > 0 &&
    !filter.priorities.includes(item.priority ?? 'none')
  ) {
    return false;
  }
  if (filter.due && !dueHolds(filter.due.window, filter.due.orOverdue, item.dueDate ?? null, on)) {
    return false;
  }
  if (!containsText(item, filter.text)) return false;
  if (filter.attachments === 'with' && !withAttachments.has(item.id)) return false;
  if (filter.attachments === 'without' && withAttachments.has(item.id)) return false;
  if (filter.agentRunning && !withRun.has(item.id)) return false;
  return true;
}

/** The ids of the Items holding at least one attachment, read once for the whole board. */
export function itemIdsWithAttachments(attachments: readonly Attachment[]): Set<string> {
  return new Set(attachments.map((attachment) => attachment.itemId));
}

/** The ids of the Items with an open run, read once for the whole board. */
export function itemIdsWithRun(runs: readonly AgentRun[]): Set<string> {
  return new Set(runs.map((run) => run.itemId));
}

const KEY = 'cockpit.dashboard-filter.';

/** What is stored for one Dashboard, unparsed, or null where nothing can be read. */
function held(store: Storage | undefined, dashboardId: string): string | null {
  try {
    return store?.getItem(KEY + dashboardId) ?? null;
  } catch {
    return null;
  }
}

/**
 * That string as a filter, field by field: whatever is not in the current shape
 * is dropped to that condition's unset value rather than throwing, so a value a
 * browser holds from another version, or one that was hand-edited, narrows less
 * rather than breaking the Dashboard.
 */
function parseFilter(raw: string | null): DashboardFilter {
  if (!raw) return NO_DASHBOARD_FILTER;
  try {
    const read: unknown = JSON.parse(raw);
    if (typeof read !== 'object' || read === null) return NO_DASHBOARD_FILTER;
    const { statuses, priorities, due, text, attachments, agentRunning } = read as Record<string, unknown>;
    const dueRead = due as { window?: unknown; orOverdue?: unknown } | null | undefined;
    return {
      statuses: Array.isArray(statuses) ? ITEM_STATUSES.filter((choice) => statuses.includes(choice)) : [],
      priorities: Array.isArray(priorities)
        ? PRIORITY_CHOICES.filter((choice) => priorities.includes(choice))
        : [],
      due:
        dueRead &&
        typeof dueRead === 'object' &&
        DUE_WINDOWS.some((window) => window === dueRead.window)
          ? { window: dueRead.window as DueWindow, orOverdue: dueRead.orOverdue !== false }
          : null,
      text: typeof text === 'string' ? text : '',
      attachments: ATTACHMENT_CHOICES.find((choice) => choice === attachments) ?? 'any',
      agentRunning: agentRunning === true,
    };
  } catch {
    return NO_DASHBOARD_FILTER;
  }
}

/** A Dashboard's stored filter, or the unset one. */
export function readDashboardFilter(
  store: Storage | undefined,
  dashboardId: string,
): DashboardFilter {
  return parseFilter(held(store, dashboardId));
}

/** Setting nothing removes the entry, so "filtered" and "has an entry" are the same fact. */
export function writeDashboardFilter(
  store: Storage | undefined,
  dashboardId: string,
  filter: DashboardFilter,
): void {
  try {
    if (isFiltering(filter)) store?.setItem(KEY + dashboardId, JSON.stringify(filter));
    else store?.removeItem(KEY + dashboardId);
  } catch {
    // Not remembering the filter is a smaller thing than one that throws.
  }
}

/** Called from `session/forget.ts`: a filter is one person's way of looking. */
export function forgetEveryDashboardFilter(store: Storage | undefined): void {
  try {
    if (!store) return;
    const ours: string[] = [];
    for (let i = 0; i < store.length; i += 1) {
      const key = store.key(i);
      if (key?.startsWith(KEY)) ours.push(key);
    }
    for (const key of ours) store.removeItem(key);
  } catch {
    // A browser that refuses storage remembered nothing to forget.
  }
}

/**
 * Everything reading a filter - the bar that sets it, the board that obeys it
 * and the tabs that carry its funnel - so a change redraws all three. A set of
 * callbacks rather than the `storage` event, which only reaches *other* tabs
 * (`useChosenLayout` says the same).
 */
const readers = new Set<() => void>();

function subscribe(onChange: () => void): () => void {
  readers.add(onChange);
  return () => {
    readers.delete(onChange);
  };
}

function tellReaders(): void {
  for (const tell of readers) tell();
}

/**
 * A Dashboard's filter, and the way to change it. The parse hangs off the
 * stored string, which is what is subscribed to, because a fresh object every
 * read would spin `useSyncExternalStore` forever.
 */
export function useDashboardFilter(
  store: Storage | undefined,
  dashboardId: string | null,
): [DashboardFilter, (next: DashboardFilter) => void] {
  const stored = useSyncExternalStore(
    subscribe,
    () => (dashboardId ? held(store, dashboardId) : null),
    () => null,
  );
  const filter = useMemo(() => parseFilter(stored), [stored]);
  const set = useCallback(
    (next: DashboardFilter) => {
      if (!dashboardId) return;
      writeDashboardFilter(store, dashboardId, next);
      tellReaders();
    },
    [store, dashboardId],
  );
  return [filter, set];
}

/** The ids, of those given, that have a filter on - what says which tabs carry a filled funnel. */
export function useFilteredDashboardIds(
  store: Storage | undefined,
  ids: readonly string[],
): ReadonlySet<string> {
  const joined = useSyncExternalStore(
    subscribe,
    () => ids.filter((id) => isFiltering(readDashboardFilter(store, id))).join(','),
    () => '',
  );
  return useMemo(() => new Set(joined ? joined.split(',') : []), [joined]);
}

/**
 * Which Dashboards have the filter bar open. **In memory only**: the bar is a
 * place to set a filter, and a filtered Dashboard shows it regardless
 * (`DashboardFilterBar`), so there is nothing here worth remembering. Per
 * Dashboard, so a bar opened on one is not on the next.
 */
const barOpenOn = new Set<string>();
let barVersion = 0;
const barReaders = new Set<() => void>();

export function useFilterBarOpen(dashboardId: string | null): [boolean, (open: boolean) => void] {
  useSyncExternalStore(
    (onChange) => {
      barReaders.add(onChange);
      return () => {
        barReaders.delete(onChange);
      };
    },
    () => barVersion,
    () => 0,
  );
  const set = useCallback(
    (next: boolean) => {
      if (!dashboardId) return;
      if (next) barOpenOn.add(dashboardId);
      else barOpenOn.delete(dashboardId);
      barVersion += 1;
      for (const tell of barReaders) tell();
    },
    [dashboardId],
  );
  return [dashboardId !== null && barOpenOn.has(dashboardId), set];
}
